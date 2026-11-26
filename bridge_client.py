"""Vault-scoped reader and sender for the installed Windows desktop bridge."""

from datetime import datetime, timezone
import inspect
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import tomllib
import uuid


SOURCE_PREFIX = "Obsidian sidebar / "
RECENT_LIMIT = 30
CODEX_JOBS = "obsidian_codex_jobs"
CODEX_TIMEOUT = 900
REQUIRED_MODEL_PREFIX_ENV = "OBSIDIAN_CANVAS_BRIDGE_REQUIRED_MODEL_PREFIX"
AGY_MODEL_ID = re.compile(r"[a-z0-9][a-z0-9._-]{1,95}")
AGY_MODEL_TIER = re.compile(r"^([a-z0-9][a-z0-9._-]+)-(?:tiered-)?(?:low|medium|high|extra|max)$")


def paired_requests(bridge, route, workspace):
    files = sorted((bridge.BUS_DIR / "requests").glob("req_*.json"), reverse=True)
    for file in files:
        if not bridge.REQUEST_ID.fullmatch(file.stem):
            continue
        item = bridge._read_json_safe(file)
        if (item and item.get("request_id") == file.stem
                and item.get("target_project_id") == route["project_id"]
                and item.get("target_conversation_id") == route["conversation_id"]
                and Path(item.get("workspace_path") or "").is_relative_to(workspace)):
            yield item


def read_task(bridge, item):
    request_id = item["request_id"]
    result = bridge.codex_tool_fetch_director_reply(request_id)
    delivery = result.get("delivery", {})
    status = delivery.get("status") or result.get("status") or "queued"
    task = {
        "id": request_id,
        "executor": "agy",
        "prompt": item.get("step_summary", ""),
        "source": "Obsidian" if (item.get("self_check") or "").startswith(SOURCE_PREFIX) else "Codex",
        "time": item.get("submitted_at", ""),
        "status": "queued" if status == "pending" else status,
        "error": result.get("error_code") or delivery.get("error_code", ""),
    }
    if result.get("replied_at"):
        same_target = all(
            result.get(key) == item[key] for key in ("target_project_id", "target_conversation_id")
        )
        if same_target:
            model = result.get("execution_model") or result.get("reply_model") or item.get("required_model") or ""
            task.update(status="replied", reply=result.get("review_feedback", ""),
                        next=result.get("next_instruction", ""), decision=result.get("decision", ""),
                        replyTime=result["replied_at"], model=model)
        else:
            task.update(status="blocked", error="回执的项目或对话与原指令不符。")
    elif not result.get("ok"):
        task["status"] = "blocked"
    elif item.get("required_model"):
        task["model"] = item["required_model"]
    return task


def matching_route(bridge, workspace, routes):
    matcher = getattr(bridge, "_matching_workspace_route", None)
    if callable(matcher):
        return matcher({"workspace_path": str(workspace)}, routes)
    ws = Path(workspace)
    candidates = []
    for route in routes:
        root = route.get("workspace_path") if isinstance(route, dict) else ""
        if root and ws.is_relative_to(root):
            candidates.append(route)
    return max(candidates, key=lambda route: len(route["workspace_path"]), default=None)


def resolve_route(bridge, workspace):
    pair = bridge.tool_workspace_pair("get", str(workspace))
    route = pair.get("route")
    reason = pair.get("error_code") or ""
    if route:
        return route, reason
    route = matching_route(bridge, workspace, bridge._workspace_routes().values())
    if not route:
        return {}, reason
    if route.get("status") == "confirmed" and not bridge._project_verified_route(route):
        return {**route, "status": "blocked", "error_code": "ANTIGRAVITY_PROJECT_UNCONFIRMED"}, ""
    return route, ""


def codex_home_dir():
    return Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")


def codex_catalog_path(codex_home):
    try:
        with (codex_home / "config.toml").open("rb") as handle:
            configured = tomllib.load(handle).get("model_catalog_json")
    except (OSError, ValueError):
        configured = None
    if isinstance(configured, str) and configured.strip():
        candidate = Path(configured.strip())
        resolved = candidate if candidate.is_absolute() else codex_home / candidate
        if resolved.is_file():
            return resolved
    return codex_home / "models_cache.json"


def codex_model_rank(model_id):
    prefix = required_model_prefix()
    remainder = model_id[len(prefix):] if prefix and model_id.startswith(prefix) else model_id
    if remainder.startswith("codex/"):
        return 0
    if remainder.startswith("cx/"):
        return 1
    if remainder.startswith("auto/"):
        return 2
    return 3


def codex_models_catalog(default_profile):
    path = codex_catalog_path(codex_home_dir())
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    raw_models = data.get("models") if isinstance(data, dict) else None
    models = []
    seen = set()
    fallback_effort = default_profile.get("effort") or "high"
    if isinstance(raw_models, list):
        for item in raw_models:
            if not isinstance(item, dict) or item.get("visibility") not in (None, "", "list"):
                continue
            slug = str(item.get("slug") or "").strip()
            if not is_allowed_model(slug) or slug in seen:
                continue
            seen.add(slug)
            efforts = [
                lvl["effort"] for lvl in (item.get("supported_reasoning_levels") or [])
                if isinstance(lvl, dict) and isinstance(lvl.get("effort"), str) and lvl["effort"]
            ] or ["low", "medium", "high"]
            models.append({
                "id": slug,
                "label": str(item.get("display_name") or slug),
                "efforts": efforts,
                "defaultEffort": str(item.get("default_reasoning_level") or fallback_effort),
            })
    default_model = default_profile.get("model", "")
    if is_allowed_model(default_model) and default_model not in seen:
        models.insert(0, {
            "id": default_model, "label": default_model,
            "efforts": ["low", "medium", "high", "xhigh"], "defaultEffort": fallback_effort,
        })
    indexed = sorted(enumerate(models), key=lambda pair: (codex_model_rank(pair[1]["id"]), pair[0]))
    return [item for _, item in indexed], path.name if path.is_file() else ""


def agy_models_catalog(bridge, routing_result):
    raw_models = ((routing_result.get("antigravity_catalog") or {}).get("models") or [])
    models = []
    seen = set()
    for item in raw_models:
        if not isinstance(item, dict):
            continue
        slug = str(item.get("slug") or "").strip()
        if not slug or slug in seen:
            continue
        seen.add(slug)
        models.append({
            "id": slug,
            "label": str(item.get("display_name") or slug),
            "family": str(item.get("family") or ""),
        })
    deliveries_dir = bridge.BUS_DIR / "deliveries"
    if deliveries_dir.is_dir():
        files = sorted(deliveries_dir.glob("req_*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:30]
        for file in files:
            state = bridge._read_json_safe(file) or {}
            for raw in (state.get("required_model"), state.get("observed_model")):
                if not isinstance(raw, str):
                    continue
                val = raw.strip()
                match = AGY_MODEL_TIER.fullmatch(val)
                if match:
                    val = match.group(1)
                if val and val not in seen and AGY_MODEL_ID.fullmatch(val):
                    seen.add(val)
                    models.append({"id": val, "label": val, "family": ""})
    return models


def snapshot(bridge, workspace):
    route, pair_error = resolve_route(bridge, workspace)
    verified = bridge._project_verified_route(route)
    recent = sorted(paired_requests(bridge, route, workspace),
                    key=lambda item: timestamp(item.get("submitted_at")), reverse=True) if verified else []
    tasks = [read_task(bridge, item) for item in recent[:RECENT_LIMIT]]
    tasks.extend(codex_task(job) for job in workspace_jobs(bridge, workspace))
    tasks.sort(key=lambda task: timestamp(task["time"]), reverse=True)
    profile, routing_result, codex_error = {"model": "", "effort": "", "speed": ""}, {}, ""
    try:
        profile, routing_result = routing_info(bridge)
    except (AttributeError, OSError, ValueError, RuntimeError) as error:
        codex_error = f"无法读取 Codex 路由配置：{error}"
    model = profile["model"]
    codex_models, codex_source = codex_models_catalog(profile)
    agy_models = agy_models_catalog(bridge, routing_result)
    decision_model = ((routing_result.get("settings") or {}).get("decision_profile") or {}).get("model") or ""
    codex_ready = is_allowed_model(model)
    if not codex_ready and not codex_error:
        codex_error = model_guard_error()
    return {
        "ok": True,
        "paired": verified,
        "project": route.get("project_id", ""),
        "conversation": route.get("conversation_id", ""),
        "reason": route.get("error_code") or pair_error,
        "codex_ready": codex_ready,
        "codex_model": model,
        "codex_default_effort": profile["effort"] or "high",
        "codex_catalog_source": codex_source,
        "codex_models": codex_models,
        "agy_models": agy_models,
        "agy_default_model": decision_model if isinstance(decision_model, str) else "",
        "codex_error": codex_error,
        "tasks": tasks[:RECENT_LIMIT],
    }


def timestamp(value):
    try:
        date = datetime.fromisoformat(value)
        return (date if date.tzinfo else date.replace(tzinfo=timezone.utc)).timestamp()
    except (ValueError, TypeError, OverflowError, OSError):
        return float("-inf")


def routing_info(bridge):
    result = bridge.tool_routing_settings(action="get")
    if result.get("ok") is False:
        raise RuntimeError(result.get("error") or result.get("error_code") or "桥接配置读取失败。")
    profile = (result.get("settings") or {}).get("worker_profile") or {}
    parsed = {field: value if isinstance(value := profile.get(field), str) else ""
              for field in ("model", "effort", "speed")}
    return parsed, result


def worker_profile(bridge):
    return routing_info(bridge)[0]


def required_model_prefix():
    return os.environ.get(REQUIRED_MODEL_PREFIX_ENV, "").strip()


def model_guard_error(prefix=None):
    active = required_model_prefix() if prefix is None else prefix
    if active:
        return f"拒绝派发：worker_profile.model 未匹配必需前缀 {active}*，已触发额度护栏。"
    return "拒绝派发：未配置可用的 Codex worker_profile.model。"


def is_allowed_model(model, prefix=None):
    if not isinstance(model, str):
        return False
    value = model.strip()
    if not value:
        return False
    active = required_model_prefix() if prefix is None else prefix
    if not active:
        return True
    return value.startswith(active) and bool(value[len(active):].strip())


def workspace_jobs(bridge, workspace):
    for file in (bridge.BUS_DIR / CODEX_JOBS).glob("job_*.json"):
        job = bridge._read_json_safe(file)
        if (isinstance(job, dict) and file.stem == f"job_{job.get('job_id')}"
                and os.path.normcase(job.get("workspace") or "") == os.path.normcase(workspace)):
            yield job


def codex_task(job):
    return {
        "id": job["job_id"], "executor": "codex", "mode": job.get("mode", ""),
        "canvasPath": job.get("canvas_path", ""), "selectedIds": job.get("selected_ids", []),
        "targetWorkspace": job.get("target_workspace", ""), "status": job.get("status", "running"),
        "prompt": job.get("prompt", ""), "reply": job.get("reply", ""),
        "time": job.get("submitted_at", ""), "replyTime": job.get("replyTime", ""),
        "error": job.get("error", ""), "model": job.get("observed_model") or job.get("requested_model", ""),
    }


def write_job(file, job):
    tmp = file.with_suffix(f".{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
        for attempt in range(4):
            try:
                os.replace(tmp, file)
                break
            except PermissionError as error:
                # Windows readers can briefly deny replacement of an open file.
                if getattr(error, "winerror", None) not in (5, 32) or attempt == 3:
                    raise
                time.sleep(0.025)
    finally:
        tmp.unlink(missing_ok=True)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def dispatch_codex(bridge, server, workspace, payload):
    token = str(payload.get("token", "")).strip()
    if not token:
        raise ValueError("Codex 指令缺少幂等 token。")
    directory = bridge.BUS_DIR / CODEX_JOBS
    with bridge._mutex(directory / "dispatch.mutex"):
        for job in workspace_jobs(bridge, workspace):
            if job.get("token") == token:
                return {"ok": True, "job_id": job["job_id"]}
        profile = worker_profile(bridge)
        selected_model = str(payload.get("model") or "").strip()
        selected_effort = str(payload.get("effort") or "").strip()
        model = selected_model or profile["model"]
        effort = selected_effort or profile["effort"]
        if not is_allowed_model(model):
            return {"ok": False, "error": model_guard_error()}
        if selected_model:
            catalog_ids = {item["id"] for item in codex_models_catalog(profile)[0]}
            if selected_model != profile["model"] and selected_model not in catalog_ids:
                return {"ok": False, "error": f"所选 Codex 模型不可用：{selected_model}"}
        target = Path((payload.get("target_workspace") or "").strip() or workspace)
        if not target.is_absolute() or not target.is_dir():
            return {"ok": False, "error": "目标工作目录必须是已存在的本地绝对路径。"}
        text = payload["text"].strip()
        if not text:
            return {"ok": False, "error": "请输入指令。"}
        job_id = uuid.uuid4().hex
        file = directory / f"job_{job_id}.json"
        job = {
            "job_id": job_id, "status": "running", "executor": "codex",
            "mode": payload.get("mode", "execute_task"), "workspace": str(workspace),
            "target_workspace": str(target.resolve()), "canvas_path": payload.get("canvas_path", ""),
            "selected_ids": payload.get("selected_ids", []), "prompt": text,
            "step_goal": payload.get("step_goal") or "处理 Obsidian 指令",
            "requested_model": model, "requested_effort": effort,
            "model_selected": bool(selected_model or selected_effort),
            "submitted_at": now_iso(), "token": token,
        }
        write_job(file, job)
        try:
            subprocess.Popen(
                [sys.executable, "-I", "-B", "-X", "utf8", str(Path(__file__).resolve()),
                 "--codex-worker", str(server), str(file)],
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "DETACHED_PROCESS", 0),
                close_fds=True,
            )
        except Exception as error:
            message = f"无法启动 Codex 后台任务：{error}"
            write_job(file, {**job, "status": "blocked", "error": message, "replyTime": now_iso()})
            return {"ok": False, "error": message}
    return {"ok": True, "job_id": job_id}


def execution_result(bridge, dispatch_id):
    file = bridge._execution_path(dispatch_id)
    deadline = time.monotonic() + CODEX_TIMEOUT
    while time.monotonic() < deadline:
        execution = bridge._read_json_safe(file) or {}
        if execution.get("status") in ("completed", "failed"):
            return execution
        time.sleep(0.5)
    raise TimeoutError(f"等待 Codex 执行结果超时（{CODEX_TIMEOUT} 秒）。")


def require_result(result, field, fallback):
    if not result.get("ok") or not result.get(field):
        raise RuntimeError(result.get("error") or result.get("error_code") or result.get("message") or fallback)
    return result[field]


def finalize_job(job, execution):
    completed = execution["status"] == "completed"
    error = execution.get("error") or execution.get("error_code") or ("" if completed else "Codex 执行失败。")
    job.update(status="replied" if completed else "blocked", reply=execution.get("raw_reply", ""),
               observed_model=execution.get("observed_model", ""), replyTime=execution.get("completed_at", ""), error=error)


def _supports_ephemeral_bind(bind_fn):
    try:
        param = inspect.signature(bind_fn).parameters.get("ephemeral")
    except (TypeError, ValueError):
        return False
    return param is not None and param.kind in (
        inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY,
    )


def _unbind_quietly(bridge, binding_id):
    if binding_id and callable(getattr(bridge, "tool_unbind_session", None)):
        try:
            bridge.tool_unbind_session(binding_id)
        except Exception:
            pass


def _bind_ephemeral_session(bridge, workspace_path, model, effort, speed):
    kwargs = dict(
        workspace_path=workspace_path, transport="codex_exec", mode="autopilot",
        codex_model=model, codex_effort=effort, codex_speed=speed,
        reuse_workspace_binding=False,
    )
    if _supports_ephemeral_bind(bridge.tool_bind_session):
        kwargs["ephemeral"] = True
    binding = bridge.tool_bind_session(**kwargs)
    binding_id = require_result(binding, "binding_id", "建立 Codex 会话失败。")
    bound_profile = (binding.get("lock") or {}).get("model_profile")
    if bound_profile is not None and bound_profile.get("model") != model:
        _unbind_quietly(bridge, binding_id)
        raise ValueError("拒绝派发：新建会话的模型与已选模型不一致。")
    return binding_id


def acquire_codex_binding(bridge, job, model, effort, speed) -> tuple[str, bool]:
    workspace_path = job["target_workspace"]
    binding = bridge.tool_bind_session(
        workspace_path=workspace_path, transport="codex_exec", mode="autopilot",
        codex_model=model, codex_effort=effort, codex_speed=speed,
        reuse_workspace_binding=True,
    )
    if not binding.get("ok") and binding.get("error_code") == "AMBIGUOUS_WORKSPACE_BINDINGS":
        return _bind_ephemeral_session(bridge, workspace_path, model, effort, speed), True

    binding_id = require_result(binding, "binding_id", "建立 Codex 会话失败。")
    bound_profile = (binding.get("lock") or {}).get("model_profile")
    if bound_profile is not None or binding.get("reused"):
        bound_model = (bound_profile or {}).get("model")
        bound_effort = (bound_profile or {}).get("effort") or ""
        mismatch = bound_model != model or (effort and bound_effort not in ("", effort))
        if mismatch:
            if not is_allowed_model(bound_model) and not job.get("model_selected"):
                raise ValueError("拒绝派发：复用会话的模型未通过当前模型护栏校验。")
            return _bind_ephemeral_session(bridge, workspace_path, model, effort, speed), True
    return binding_id, False


def execute_codex_job(bridge, file, job):
    profile = worker_profile(bridge)
    if not is_allowed_model(profile["model"]):
        raise ValueError(model_guard_error())
    model = job.get("requested_model") or profile["model"]
    effort = job.get("requested_effort") or profile["effort"]
    if not is_allowed_model(model):
        raise ValueError(model_guard_error())
    binding_id, ephemeral_binding = acquire_codex_binding(bridge, job, model, effort, profile["speed"])
    try:
        job.update(binding_id=binding_id, requested_model=model, requested_effort=effort)
        dispatch = bridge.tool_dispatch_task(
            binding_id=binding_id, step_goal=job["step_goal"], task_instruction=job["prompt"],
            constraints="遵循指令中的 Canvas 回写契约，由用户在 Obsidian 中应用补丁。" if job["canvas_path"] else "",
            wait_for_result=False, reply_format="natural", routing_tag="obsidian-canvas",
        )
        dispatch_id = dispatch.get("dispatch_id")
        if dispatch_id:
            job["dispatch_id"] = dispatch_id
        if dispatch_id and not dispatch.get("ok"):
            final = bridge._read_json_safe(bridge._execution_path(dispatch_id)) or {}
            if final.get("status") in ("completed", "failed"):
                finalize_job(job, final)
                return
        require_result(dispatch, "dispatch_id", "Codex 派发失败。")
        write_job(file, job)
        finalize_job(job, execution_result(bridge, dispatch_id))
    finally:
        if ephemeral_binding:
            _unbind_quietly(bridge, binding_id)


def codex_worker(server, file):
    job = json.loads(file.read_text(encoding="utf-8"))
    try:
        execute_codex_job(load_bridge(server), file, job)
    except Exception as error:
        job.update(status="blocked", error=str(error) or type(error).__name__, replyTime=now_iso())
    write_job(file, job)


def submit_mcp(server, workspace, text, marker, required_model="", target_conversation_id=""):
    codex_dir = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    with (codex_dir / "config.toml").open("rb") as handle:
        entry = tomllib.load(handle)["mcp_servers"]["antigravity_bridge"]
    args = entry["args"]
    if (not any(Path(arg) == server for arg in args)
            or not any(args[i:i + 2] == ["--role", "codex"] for i in range(len(args)))):
        raise ValueError("Codex 与 Antigravity 的桥接服务配置不一致。")
    arguments = {
        "workspace_path": str(workspace), "wait_for_reply": False,
        "step_summary": text, "self_check": marker,
    }
    if required_model:
        arguments["required_model"] = required_model
        if target_conversation_id:
            arguments["target_conversation_id"] = target_conversation_id
    messages = [
        {"id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "obsidian-canvas-bridge", "version": "1.1.0"},
        }},
        {"method": "notifications/initialized"},
        {"id": 2, "method": "tools/call", "params": {
            "name": "agy_submit_for_review", "arguments": arguments,
        }},
    ]
    wire = "".join(json.dumps({"jsonrpc": "2.0", **message}) + "\n" for message in messages)
    run = subprocess.run(
        [entry["command"], *args], input=wire, cwd=workspace, encoding="utf-8",
        capture_output=True, timeout=12, env={**os.environ, **entry.get("env", {})},
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    for line in run.stdout.splitlines():
        message = json.loads(line)
        if message.get("id") == 2 and "result" in message:
            return json.loads(message["result"]["content"][0]["text"])
    raise RuntimeError("发送结果待确认。刷新记录后可重试同一条指令。")


def send(bridge, server, workspace, payload):
    text = payload["text"].strip()
    if not text:
        raise ValueError("请输入指令。")
    selected_model = str(payload.get("model") or "").strip()
    if selected_model and not AGY_MODEL_ID.fullmatch(selected_model):
        raise ValueError(f"Antigravity 模型名称无效：{selected_model}")
    marker = SOURCE_PREFIX + str(uuid.UUID(payload["token"]))
    # Route changes and retries share the host's route lock until the MCP enqueue returns.
    with bridge._mutex(bridge.BUS_DIR / "workspace_routes.mutex"):
        routes = bridge._workspace_routes()
        route = routes.get(os.path.normcase(workspace)) or matching_route(bridge, workspace, routes.values()) or {}
        if (not bridge._project_verified_route(route) or route.get("project_id") != payload["project"]
                or route.get("conversation_id") != payload["conversation"]):
            raise ValueError("配对已变化。请核对侧栏的收件对话再发送。")
        for item in paired_requests(bridge, route, workspace):
            if item.get("self_check") == marker:
                if item.get("step_summary") != text:
                    raise ValueError("这条指令的发送记录与草稿不一致。")
                return {"ok": True, "request_id": item["request_id"]}
        if selected_model:
            result = submit_mcp(server, workspace, text, marker, selected_model, route["conversation_id"])
        else:
            result = submit_mcp(server, workspace, text, marker)
        if not result.get("ok"):
            raise RuntimeError(result.get("error_code") or result.get("message") or "桥接未接受指令。")
        request_id = result.get("request_id", "")
        if not bridge.REQUEST_ID.fullmatch(request_id):
            raise RuntimeError("桥接还未返回有效的请求编号。")
        return {"ok": True, "request_id": request_id}


def load_bridge(server):
    server = server.resolve(strict=True)
    sys.path.insert(0, str(server.parent))
    import bridge_server as bridge
    if Path(bridge.__file__).resolve() != server:
        raise ValueError("无法定位已登记的桥接程序。")
    return bridge


def main():
    if sys.argv[1] == "--codex-worker":
        codex_worker(Path(sys.argv[2]), Path(sys.argv[3]))
        return None
    server = Path(sys.argv[1]).resolve(strict=True)
    bridge = load_bridge(server)
    payload = json.load(sys.stdin)
    workspace = Path(payload["workspace"]).resolve(strict=True)
    if payload["action"] == "snapshot":
        return snapshot(bridge, workspace)
    if payload["action"] == "send":
        return send(bridge, server, workspace, payload)
    if payload["action"] == "dispatch_codex":
        return dispatch_codex(bridge, server, workspace, payload)
    raise ValueError("未知的侧栏操作。")


if __name__ == "__main__":
    try:
        response = main()
    except subprocess.TimeoutExpired:
        response = {"ok": False, "error": "桥接响应超时。可刷新或重试同一条指令。"}
    except (OSError, KeyError, ValueError, RuntimeError, ImportError, IndexError) as error:
        response = {"ok": False, "error": str(error)}
    if response is not None:
        print(json.dumps(response, ensure_ascii=False))
