from contextlib import contextmanager
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from textwrap import dedent
from unittest.mock import Mock, call, patch

import bridge_client


MODEL = "provider/codex/model-a"


class FakeBridge:
    REQUEST_ID = re.compile(r"req_\d+")

    def __init__(self, root, model=MODEL):
        self.BUS_DIR = root
        self.model = model
        self.route = {}
        self.tool_bind_session = Mock(return_value={"ok": True, "binding_id": "binding"})
        self.tool_dispatch_task = Mock(return_value={"ok": True, "dispatch_id": "dispatch"})
        self.codex_tool_fetch_director_reply = Mock(return_value={"ok": True, "status": "pending"})

    @contextmanager
    def _mutex(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        yield

    def tool_routing_settings(self, action="get"):
        return {"settings": {"worker_profile": {"model": self.model, "effort": "high", "speed": "fast"}}}

    def _read_json_safe(self, path):
        try:
            return json.loads(Path(path).read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return None

    def tool_workspace_pair(self, *_args):
        return {"route": self.route, "error_code": "" if self.route else "NOT_PAIRED"}

    def _project_verified_route(self, route):
        return bool(route)

    def _workspace_routes(self):
        return {os.path.normcase(self.BUS_DIR): self.route}

    def _execution_path(self, dispatch_id):
        return self.BUS_DIR / f"{dispatch_id}.execution.json"


class BridgeClientTests(unittest.TestCase):
    def setUp(self):
        env_patch = patch.dict(os.environ, {bridge_client.REQUIRED_MODEL_PREFIX_ENV: ""})
        env_patch.start()
        self.addCleanup(env_patch.stop)
        temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(temp.cleanup)
        self.workspace = Path(temp.name)
        self.bridge = FakeBridge(self.workspace)
        self.server = self.workspace / "server.py"
        self.directory = self.workspace / bridge_client.CODEX_JOBS

    def dispatch(self, **extra):
        return bridge_client.dispatch_codex(self.bridge, self.server, self.workspace, {
            "token": "draft-1", "text": "完成任务", "step_goal": "验证", "mode": "edit_canvas",
            "canvas_path": "Board.canvas", "selected_ids": ["node"], **extra,
        })

    def read_job(self, job_id):
        return self.bridge._read_json_safe(self.directory / f"job_{job_id}.json")

    def make_job(self):
        with patch.object(subprocess, "Popen"):
            job_id = self.dispatch()["job_id"]
        return self.directory / f"job_{job_id}.json"

    def test_model_prefix_guard_rejects_unprefixed_and_empty_models(self):
        self.assertFalse(bridge_client.is_allowed_model(""))
        self.assertTrue(bridge_client.is_allowed_model("bare-model"))
        with (patch.dict(os.environ, {bridge_client.REQUIRED_MODEL_PREFIX_ENV: "provider/"}),
              patch.object(subprocess, "Popen") as popen):
            for model in ("model-a", "auto/high", "provider/"):
                with self.subTest(model=model):
                    self.bridge.model = model
                    self.assertEqual(self.dispatch(), {"ok": False, "error": bridge_client.model_guard_error("provider/")})
        popen.assert_not_called()
        self.assertEqual(list(self.directory.glob("job_*.json")), [])

    def test_dispatch_writes_job_and_detached_worker_command(self):
        def launch(command, *, creationflags, close_fds):
            file = Path(command[-1])
            self.assertEqual(file.parent, self.directory)
            self.assertEqual(self.bridge._read_json_safe(file)["status"], "running")
            self.assertTrue(close_fds)
            self.assertEqual(creationflags, 0x08000008)

        with (patch.object(subprocess, "Popen", side_effect=launch) as popen,
              patch.object(subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True),
              patch.object(subprocess, "DETACHED_PROCESS", 0x00000008, create=True)):
            result = self.dispatch()
        self.assertTrue(result["ok"])
        job_id = result["job_id"]
        self.assertEqual(popen.call_args.args[0], [
            sys.executable, "-I", "-B", "-X", "utf8", str(Path(bridge_client.__file__).resolve()),
            "--codex-worker", str(self.server), str(self.directory / f"job_{job_id}.json"),
        ])
        job = self.read_job(job_id)
        expected = {
            "job_id": job_id, "status": "running", "executor": "codex", "mode": "edit_canvas",
            "workspace": str(self.workspace), "target_workspace": str(self.workspace.resolve()),
            "canvas_path": "Board.canvas", "selected_ids": ["node"], "prompt": "完成任务",
            "step_goal": "验证", "token": "draft-1",
        }
        self.assertEqual({field: job[field] for field in expected}, expected)
        self.assertTrue(job["submitted_at"])
        self.assertEqual(list(self.directory.glob("*.tmp")), [])

    def test_token_is_idempotent(self):
        with patch.object(subprocess, "Popen") as popen:
            first = self.dispatch()
            second = self.dispatch()
        self.assertEqual(first, second)
        popen.assert_called_once()

    def test_existing_agy_send_still_reuses_the_original_request(self):
        self.bridge.route = {"project_id": "project", "conversation_id": "conversation"}
        token = str(uuid.uuid4())
        requests = self.workspace / "requests"
        requests.mkdir()
        bridge_client.write_job(requests / "req_1.json", {
            "request_id": "req_1", "step_summary": "原始指令", "workspace_path": str(self.workspace),
            "target_project_id": "project", "target_conversation_id": "conversation",
            "self_check": bridge_client.SOURCE_PREFIX + token,
        })
        payload = {"token": token, "text": "原始指令", "project": "project", "conversation": "conversation"}
        with patch.object(bridge_client, "submit_mcp") as submit:
            self.assertEqual(bridge_client.send(self.bridge, self.server, self.workspace, payload),
                             {"ok": True, "request_id": "req_1"})
            with self.assertRaisesRegex(ValueError, "草稿不一致"):
                bridge_client.send(self.bridge, self.server, self.workspace, {**payload, "text": "已修改"})
        submit.assert_not_called()

    def test_invalid_target_and_worker_start_failure(self):
        with patch.object(subprocess, "Popen", side_effect=OSError("start failed")) as popen:
            self.assertFalse(self.dispatch(target_workspace=str(self.workspace / "missing"))["ok"])
            popen.assert_not_called()
            self.assertFalse(self.dispatch()["ok"])
        job = self.bridge._read_json_safe(next(self.directory.glob("job_*.json")))
        self.assertEqual(job["status"], "blocked")
        self.assertIn("start failed", job["error"])

    def test_snapshot_merges_agy_and_codex_and_keeps_codex_without_pairing(self):
        self.directory.mkdir()
        for job_id, workspace in (("own", self.workspace), ("other", self.workspace / "other")):
            bridge_client.write_job(self.directory / f"job_{job_id}.json", {
                "job_id": job_id, "workspace": str(workspace), "status": "replied",
                "submitted_at": "2026-01-01T00:00:00-08:00", "reply": "完成", "prompt": "任务",
                "mode": "execute_task", "canvas_path": "Board.canvas", "selected_ids": ["node"],
                "target_workspace": str(workspace), "observed_model": MODEL,
            })
        self.bridge.route = {"project_id": "project", "conversation_id": "conversation"}
        requests = self.workspace / "requests"
        requests.mkdir()
        bridge_client.write_job(requests / "req_1.json", {
            "request_id": "req_1", "step_summary": "AGY text", "workspace_path": str(self.workspace),
            "target_project_id": "project", "target_conversation_id": "conversation",
            "submitted_at": "2026-01-01T12:00:00+08:00",
        })
        result = bridge_client.snapshot(self.bridge, self.workspace)
        self.assertTrue(result["paired"])
        self.assertEqual([(task["id"], task["executor"]) for task in result["tasks"]], [("own", "codex"), ("req_1", "agy")])
        self.assertEqual(result["tasks"][1]["status"], "queued")
        self.bridge.route = {}
        result = bridge_client.snapshot(self.bridge, self.workspace)
        self.assertFalse(result["paired"])
        self.assertEqual(result["reason"], "NOT_PAIRED")
        self.assertTrue(result["codex_ready"])
        self.assertEqual(result["codex_model"], MODEL)
        self.assertEqual(len(result["tasks"]), 1)
        self.assertEqual(result["tasks"][0]["selectedIds"], ["node"])
        self.assertEqual(result["tasks"][0]["model"], MODEL)

    def test_worker_polls_for_execution_and_records_reply(self):
        file = self.make_job()
        execution = {"status": "completed", "raw_reply": "完成", "observed_model": MODEL, "completed_at": "2026-11-26T00:00:00Z"}

        def finish(delay):
            self.assertEqual(delay, 0.5)
            running = self.bridge._read_json_safe(file)
            self.assertEqual(running["dispatch_id"], "dispatch")
            self.assertEqual(running["requested_model"], MODEL)
            bridge_client.write_job(self.bridge._execution_path("dispatch"), execution)

        with (patch.object(bridge_client, "load_bridge", return_value=self.bridge),
              patch.object(bridge_client.time, "sleep", side_effect=finish) as sleep):
            bridge_client.codex_worker(self.server, file)
        sleep.assert_called_once()
        self.bridge.tool_bind_session.assert_called_once_with(
            workspace_path=str(self.workspace.resolve()), transport="codex_exec", mode="autopilot",
            codex_model=MODEL, codex_effort="high", codex_speed="fast", reuse_workspace_binding=True,
        )
        args = self.bridge.tool_dispatch_task.call_args.kwargs
        self.assertEqual((args["binding_id"], args["step_goal"], args["task_instruction"], args["reply_format"], args["routing_tag"]),
                         ("binding", "验证", "完成任务", "natural", "obsidian-canvas"))
        self.assertFalse(args["wait_for_result"])
        job = self.bridge._read_json_safe(file)
        self.assertEqual((job["status"], job["reply"], job["observed_model"], job["replyTime"], job["error"]),
                         ("replied", "完成", MODEL, execution["completed_at"], ""))

    def test_worker_dispatches_to_isolated_binding_when_workspace_bindings_are_ambiguous(self):
        file = self.make_job()
        self.bridge.tool_bind_session.side_effect = [
            {"ok": False, "error_code": "AMBIGUOUS_WORKSPACE_BINDINGS", "binding_ids": ["b1", "b2"]},
            {"ok": True, "binding_id": "isolated"},
        ]
        self.bridge.tool_unbind_session = Mock()
        bridge_client.write_job(self.bridge._execution_path("dispatch"), {"status": "completed"})

        with patch.object(bridge_client, "load_bridge", return_value=self.bridge):
            bridge_client.codex_worker(self.server, file)

        bind_args = dict(
            workspace_path=str(self.workspace.resolve()), transport="codex_exec", mode="autopilot",
            codex_model=MODEL, codex_effort="high", codex_speed="fast",
        )
        self.assertEqual(self.bridge.tool_bind_session.call_args_list, [
            call(**bind_args, reuse_workspace_binding=True),
            call(**bind_args, reuse_workspace_binding=False),
        ])
        self.bridge.tool_dispatch_task.assert_called_once()
        self.assertEqual(self.bridge.tool_dispatch_task.call_args.kwargs["binding_id"], "isolated")
        self.bridge.tool_unbind_session.assert_called_once_with("isolated")
        self.assertEqual(self.bridge._read_json_safe(file)["status"], "replied")

    def test_model_switch_sets_ephemeral_when_bind_explicitly_supports_it(self):
        options = []

        def bind_session(*, reuse_workspace_binding, ephemeral=False, **kwargs):
            options.append((reuse_workspace_binding, ephemeral))
            if reuse_workspace_binding:
                return {"ok": True, "binding_id": "old", "reused": True, "lock": {"model_profile": {"model": MODEL}}}
            return {"ok": True, "binding_id": "isolated", "lock": {"model_profile": {"model": kwargs["codex_model"]}}}

        self.bridge.tool_bind_session = bind_session
        job = {"target_workspace": str(self.workspace), "model_selected": True}

        binding = bridge_client.acquire_codex_binding(self.bridge, job, "provider/codex/model-b", "high", "fast")

        self.assertEqual(binding, ("isolated", True))
        self.assertEqual(options, [(True, False), (False, True)])

    def test_worker_releases_isolated_binding_before_rejecting_mismatched_model(self):
        file = self.make_job()
        job = self.bridge._read_json_safe(file)
        self.bridge.tool_bind_session.side_effect = [
            {"ok": False, "error_code": "AMBIGUOUS_WORKSPACE_BINDINGS", "binding_ids": ["b1", "b2"]},
            {"ok": True, "binding_id": "isolated", "lock": {"model_profile": {"model": "provider/codex/model-b"}}},
        ]
        self.bridge.tool_unbind_session = Mock()

        with self.assertRaisesRegex(ValueError, "拒绝派发：新建会话的模型与已选模型不一致。"):
            bridge_client.execute_codex_job(self.bridge, file, job)

        self.bridge.tool_unbind_session.assert_called_once_with("isolated")
        self.bridge.tool_dispatch_task.assert_not_called()

    def test_worker_rechecks_model_prefix_and_refuses_incompatible_reused_binding(self):
        file = self.make_job()
        with (patch.dict(os.environ, {bridge_client.REQUIRED_MODEL_PREFIX_ENV: "provider/"}),
              patch.object(bridge_client, "load_bridge", return_value=self.bridge)):
            self.bridge.model = "auto/high"
            bridge_client.codex_worker(self.server, file)
            self.assertEqual(self.bridge._read_json_safe(file)["error"], bridge_client.model_guard_error("provider/"))
            self.bridge.tool_bind_session.assert_not_called()
            self.bridge.model = MODEL
            self.bridge.tool_bind_session.return_value = {
                "ok": True, "binding_id": "old", "reused": True, "lock": {"model_profile": {"model": "auto/high"}},
            }
            bridge_client.codex_worker(self.server, file)
        self.bridge.tool_dispatch_task.assert_not_called()
        job = self.bridge._read_json_safe(file)
        self.assertEqual(job["status"], "blocked")
        self.assertIn("复用会话", job["error"])

    def test_worker_records_timeout_as_blocked(self):
        file = self.make_job()
        with (patch.object(bridge_client, "load_bridge", return_value=self.bridge),
              patch.object(bridge_client.time, "monotonic", side_effect=[0, 900])):
            bridge_client.codex_worker(self.server, file)
        job = self.bridge._read_json_safe(file)
        self.assertEqual(job["status"], "blocked")
        self.assertIn("900 秒", job["error"])

    def test_worker_preserves_the_reply_from_an_immediate_failed_execution(self):
        file = self.make_job()
        self.bridge.tool_dispatch_task.return_value = {"ok": False, "dispatch_id": "dispatch"}
        bridge_client.write_job(self.bridge._execution_path("dispatch"), {
            "status": "failed", "raw_reply": "部分结果", "error_code": "FAILED", "completed_at": "2026-11-26T00:00:00Z",
        })
        with patch.object(bridge_client, "load_bridge", return_value=self.bridge):
            bridge_client.codex_worker(self.server, file)
        job = self.bridge._read_json_safe(file)
        self.assertEqual((job["status"], job["reply"], job["error"], job["dispatch_id"]),
                         ("blocked", "部分结果", "FAILED", "dispatch"))

    @unittest.skipUnless(os.name == "nt", "Windows detached process flags")
    def test_detached_worker_receives_result_after_dispatch_cli_exits(self):
        server = self.workspace / "bridge_server.py"
        server.write_text(dedent(f'''\
            from contextlib import contextmanager
            import json
            from pathlib import Path

            BUS_DIR = Path(__file__).parent

            @contextmanager
            def _mutex(path):
                path.parent.mkdir(parents=True, exist_ok=True)
                yield

            def tool_routing_settings(action):
                return {{"settings": {{"worker_profile": {{"model": {MODEL!r}}}}}}}

            def tool_bind_session(**kwargs):
                return {{"ok": True, "binding_id": "binding"}}

            def tool_dispatch_task(**kwargs):
                return {{"ok": True, "dispatch_id": "dispatch"}}

            def _execution_path(dispatch_id):
                return BUS_DIR / f"{{dispatch_id}}.execution.json"

            def _read_json_safe(path):
                return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
        '''), encoding="utf-8")
        execution_file = self.bridge._execution_path("dispatch")
        try:
            result = subprocess.run(
                [sys.executable, "-I", "-B", "-X", "utf8", bridge_client.__file__, str(server)],
                input=json.dumps({"action": "dispatch_codex", "workspace": str(self.workspace),
                                  "token": "detached", "text": "验证"}),
                capture_output=True, text=True, encoding="utf-8", timeout=8, check=True,
                env={**os.environ, bridge_client.REQUIRED_MODEL_PREFIX_ENV: ""},
            )
        finally:
            bridge_client.write_job(execution_file, {"status": "completed", "raw_reply": "收到"})
        response = json.loads(result.stdout)
        self.assertTrue(response["ok"], response)
        deadline = time.monotonic() + 8
        job = self.read_job(response["job_id"])
        while job["status"] == "running" and time.monotonic() < deadline:
            time.sleep(0.05)
            job = self.read_job(response["job_id"])
        self.assertEqual(job["status"], "replied", job)
        self.assertEqual(job["reply"], "收到")

    def test_subdirectory_vault_inherits_parent_confirmed_route(self):
        parent = self.workspace
        sub = self.workspace / "Design"
        sub.mkdir()
        parent_route = {
            "workspace_path": str(parent), "project_id": "demo-proj",
            "conversation_id": "demo-conv", "status": "confirmed",
        }
        self.bridge.tool_workspace_pair = Mock(return_value={"ok": True, "route": None, "error_code": ""})
        self.bridge._workspace_routes = Mock(return_value={os.path.normcase(parent): parent_route})

        snap = bridge_client.snapshot(self.bridge, sub)
        self.assertTrue(snap["paired"])
        self.assertEqual((snap["project"], snap["conversation"]), ("demo-proj", "demo-conv"))

        with patch.object(bridge_client, "submit_mcp", return_value={"ok": True, "request_id": "req_99"}) as submit:
            res = bridge_client.send(self.bridge, self.server, sub, {
                "token": str(uuid.uuid4()), "text": "测试子目录继承",
                "project": "demo-proj", "conversation": "demo-conv",
            })
        self.assertEqual(res, {"ok": True, "request_id": "req_99"})
        submit.assert_called_once()

    def test_dynamic_catalogs_in_snapshot_and_codex_model_override(self):
        codex_home = self.workspace / "codex_home"
        codex_home.mkdir()
        (codex_home / "config.toml").write_text('model_catalog_json = "custom.json"\n', encoding="utf-8")
        (codex_home / "custom.json").write_text(json.dumps({
            "models": [
                {"slug": "model-a", "display_name": "Bare", "visibility": "list"},
                {"slug": "auto/model-a", "display_name": "Auto", "visibility": "list"},
                {"slug": "provider/auto/best-coding", "display_name": "Best Coding", "visibility": "list",
                 "supported_reasoning_levels": [{"effort": "low"}, {"effort": "high"}]},
                {"slug": "provider/codex/model-b", "display_name": "Model B", "visibility": "list",
                 "supported_reasoning_levels": [{"effort": "high"}, {"effort": "xhigh"}]},
                {"slug": "provider/codex/hidden", "display_name": "Hidden", "visibility": "hide"},
            ]
        }), encoding="utf-8")
        self.bridge.tool_routing_settings = Mock(return_value={
            "ok": True,
            "settings": {"worker_profile": {"model": MODEL, "effort": "high", "speed": "fast"},
                         "decision_profile": {"model": "example-model-a"}},
            "antigravity_catalog": {"models": [{"slug": "example-model-a", "display_name": "Example Model A", "family": "Example"}]},
        })
        deliveries = self.workspace / "deliveries"
        deliveries.mkdir()
        bridge_client.write_job(deliveries / "req_1.json", {"observed_model": "example-model-b"})

        with patch.dict(os.environ, {"CODEX_HOME": str(codex_home), bridge_client.REQUIRED_MODEL_PREFIX_ENV: "provider/"}):
            snap = bridge_client.snapshot(self.bridge, self.workspace)
            self.assertEqual([m["id"] for m in snap["codex_models"]],
                             [MODEL, "provider/codex/model-b", "provider/auto/best-coding"])
            self.assertEqual(snap["codex_catalog_source"], "custom.json")
            self.assertEqual([m["id"] for m in snap["agy_models"]], ["example-model-a", "example-model-b"])

            with patch.object(subprocess, "Popen") as popen:
                bad = self.dispatch(model="model-a")
                self.assertEqual(bad, {"ok": False, "error": bridge_client.model_guard_error("provider/")})
                unknown = self.dispatch(model="provider/codex/nonexistent")
                self.assertFalse(unknown["ok"])
                ok = self.dispatch(model="provider/codex/model-b", effort="xhigh")
                self.assertTrue(ok["ok"])
            popen.assert_called_once()

            job_file = self.directory / f"job_{ok['job_id']}.json"
            self.bridge.tool_bind_session = Mock(side_effect=[
                {"ok": True, "binding_id": "reused-b", "reused": True, "lock": {"model_profile": {"model": MODEL, "effort": "high"}}},
                {"ok": True, "binding_id": "fresh-b", "reused": False, "lock": {"model_profile": {"model": "provider/codex/model-b", "effort": "xhigh"}}},
            ])
            self.bridge.tool_unbind_session = Mock(return_value={"ok": True})
            bridge_client.write_job(self.bridge._execution_path("dispatch"), {
                "status": "completed", "raw_reply": "ok", "observed_model": "provider/codex/model-b",
            })
            with patch.object(bridge_client, "load_bridge", return_value=self.bridge):
                bridge_client.codex_worker(self.server, job_file)
        self.assertEqual(self.bridge.tool_bind_session.call_count, 2)
        self.assertEqual(self.bridge.tool_dispatch_task.call_args.kwargs["binding_id"], "fresh-b")
        self.bridge.tool_unbind_session.assert_called_once_with("fresh-b")

    def test_agy_send_passes_required_model_only_when_selected(self):
        self.bridge.route = {"project_id": "project", "conversation_id": "conversation"}
        with patch.object(bridge_client, "submit_mcp", return_value={"ok": True, "request_id": "req_101"}) as submit:
            bridge_client.send(self.bridge, self.server, self.workspace, {
                "token": str(uuid.uuid4()), "text": "默认模型", "project": "project", "conversation": "conversation",
            })
            submit.assert_called_once_with(self.server, self.workspace, "默认模型", unittest.mock.ANY)
            submit.reset_mock()
            bridge_client.send(self.bridge, self.server, self.workspace, {
                "token": str(uuid.uuid4()), "text": "指定模型", "project": "project",
                "conversation": "conversation", "model": "example-model-b",
            })
            submit.assert_called_once_with(self.server, self.workspace, "指定模型", unittest.mock.ANY,
                                             "example-model-b", "conversation")


if __name__ == "__main__":
    unittest.main()
