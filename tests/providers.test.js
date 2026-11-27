const test = require("node:test");
const assert = require("node:assert/strict");
const { extractSelectionSnapshot, buildCanvasPromptEnvelope } = require("../canvas_context.js");
const {
  DEFAULT_SETTINGS, parseModelList, normalizeSettings, ProviderRegistry, LocalTaskStore,
  normalizeChatCompletionsUrl, extractChatCompletionReply, createOpenAICompatibleProvider,
} = require("../providers.js");

const jsonReply = content => ({ choices: [{ message: { content } }] });
const config = overrides => ({ ...DEFAULT_SETTINGS.openaiProviders[0], enabled: true, ...overrides });

test("parses comma-, newline-, and array-based model lists in order", () => {
  assert.deepEqual(parseModelList(" A , B\r\nA\n\n C ,"), ["A", "B", "C"]);
  assert.deepEqual(parseModelList(["a", "b, c", null, 42, " a ", "A"]), ["a", "b", "c", "A"]);
  assert.deepEqual(parseModelList(undefined), []);
});

test("normalizes arbitrary saved settings without mutating the defaults", () => {
  const defaults = normalizeSettings(null);
  assert.deepEqual(defaults, DEFAULT_SETTINGS);
  defaults.openaiProviders[0].models.push("other");
  assert.equal(normalizeSettings().openaiProviders[0].models.length, 2);
  assert.deepEqual(normalizeSettings({ openaiProviders: [] }).openaiProviders, []);
  assert.deepEqual(normalizeSettings({ openaiProviders: "broken" }), DEFAULT_SETTINGS);
  const settings = normalizeSettings({ enableBridge: false, openaiProviders: [
    { id: "  My API! ", enabled: true, models: "a, b", defaultModel: " b ", temperature: 0, maxTokens: 10 },
    { id: "my-api", models: ["one", "two", "one"], defaultModel: "missing", apiKey: 123, maxTokens: -1 },
    { id: "你好", models: [] }, null, { id: "codex", defaultModel: "solo" },
  ] });
  assert.equal(settings.enableBridge, false);
  const profiles = settings.openaiProviders;
  assert.deepEqual(profiles.map(item => item.id), ["my-api", "my-api-2", "openai-provider-3", "openai-provider-4", "codex-2"]);
  assert.deepEqual(profiles.map(item => item.defaultModel), ["b", "one", "", "gpt-4.1-mini", "solo"]);
  assert.deepEqual([profiles[0].temperature, profiles[0].maxTokens, profiles[1].temperature, profiles[1].maxTokens], [0, 10, null, null]);
  assert.equal(profiles[1].apiKey, "");
  assert.deepEqual(normalizeSettings(settings), settings);
});

test("normalizes Chat Completions endpoints and rejects invalid protocols", () => {
  assert.equal(normalizeChatCompletionsUrl(" https://api.example.test/v1/// "), "https://api.example.test/v1/chat/completions");
  assert.equal(normalizeChatCompletionsUrl("http://localhost:12345"), "http://localhost:12345/chat/completions");
  assert.equal(normalizeChatCompletionsUrl("https://api.example.test/path/chat/completions/?version=1"),
    "https://api.example.test/path/chat/completions?version=1");
  assert.throws(() => normalizeChatCompletionsUrl("file:///settings"), /http:\/\/ or https:\/\//);
  assert.throws(() => normalizeChatCompletionsUrl("missing-host"), /valid/);
});

test("extracts string and text-part replies and rejects absent text", () => {
  assert.equal(extractChatCompletionReply(jsonReply("# Answer\n")), "# Answer\n");
  assert.equal(extractChatCompletionReply(jsonReply([
    { type: "text", text: "Hello " }, { type: "image_url" }, { type: "text", text: "world" },
  ])), "Hello world");
  assert.throws(() => extractChatCompletionReply({}), /choices\[0\]/);
  assert.throws(() => extractChatCompletionReply(jsonReply([{ type: "image_url" }])), /contain text/);
});

test("registry validates required methods and keeps the registration order", () => {
  const registry = new ProviderRegistry();
  const first = { id: "first", label: "First", getStatus() {}, listTasks() {}, dispatch() {} };
  const second = { ...first, id: "second", enabled: false };
  const replacement = { ...first, label: "Replacement" };
  assert.equal(registry.register(first), first);
  registry.register(second);
  registry.register(replacement);
  assert.deepEqual(registry.list(), [replacement, second]);
  assert.deepEqual(registry.listEnabled(), [replacement]);
  assert.equal(registry.get("first"), replacement);
  assert.equal(registry.unregister("first"), true);
  assert.equal(registry.unregister("first"), false);
  for (const method of ["getStatus", "listTasks", "dispatch"]) {
    assert.throws(() => registry.register({ ...first, [method]: null }), new RegExp(method));
  }
  assert.throws(() => registry.register(null), /object/);
  assert.throws(() => registry.register({ ...first, id: "Bad ID" }), /id/);
  assert.throws(() => registry.register({ ...first, label: "" }), /label/);
});

test("persists task state and deduplicates tokens within a workspace and executor", () => {
  let saved;
  const persistence = { load: () => saved, save: value => { saved = JSON.parse(JSON.stringify(value)); } };
  const store = new LocalTaskStore(persistence);
  const task = { executor: "first", token: "draft-1", prompt: "Edit", selectedIds: ["node-1"] };
  const original = store.create("vault-a", task);
  assert.equal(original.status, "running");
  assert.equal(store.create("vault-a", { ...task, prompt: "Another prompt" }).id, original.id);
  assert.notEqual(store.create("vault-a", { ...task, executor: "second" }).id, original.id);
  assert.notEqual(store.create("vault-b", task).id, original.id);
  const updated = store.update("vault-a", original.id, { status: "replied", reply: "Done", replyTime: "2026-01-02T00:00:00Z" });
  assert.equal(updated.reply, "Done");
  updated.selectedIds.push("other");
  assert.deepEqual(store.list("vault-a", "first")[0].selectedIds, ["node-1"]);
  const restored = new LocalTaskStore(persistence);
  assert.equal(restored.findByToken("vault-a", "first", task.token).status, "replied");
  assert.equal(restored.create("vault-a", task).id, original.id);
  assert.equal(restored.list("vault-a").length, 2);
  assert.equal(restored.list("vault-b").length, 1);
});

test("retains the newest 30 tasks per workspace and ignores updates to evicted tasks", () => {
  const store = new LocalTaskStore();
  const other = store.create("vault-b", { executor: "other" });
  for (let index = 0; index < 34; index++) {
    store.create("vault-a", { id: `task-${index}`, executor: "first", time: new Date(index * 1000).toISOString() });
  }
  store.create("vault-a", { id: "earlier", executor: "first", time: "1969-01-01T00:00:00Z" });
  const tasks = store.list("vault-a");
  assert.equal(tasks.length, 30);
  assert.equal(tasks[0].id, "task-33");
  assert.equal(tasks.at(-1).id, "task-4");
  assert.equal(store.update("vault-a", "task-3", { status: "replied" }), undefined);
  assert.equal(store.list("vault-b")[0].id, other.id);
});

test("queues a Canvas prompt immediately, sends system and user messages, and stores the completion once", async () => {
  const snapshot = extractSelectionSnapshot({ nodes: [{ id: "n1", type: "text", text: "draft" }], edges: [] }, ["n1"], "Board.canvas");
  const prompt = buildCanvasPromptEnvelope({
    userInstruction: "Edit this node", executor: "openai-compatible", mode: "edit_canvas", canvasSnapshot: snapshot,
  });
  const store = new LocalTaskStore();
  const calls = [];
  const notifications = [];
  let resolveRequest;
  const provider = createOpenAICompatibleProvider(config({ apiKey: "sample-secret", systemPrompt: "Default system", temperature: 0, maxTokens: 64 }), {
    store,
    notify: task => notifications.push(task.status),
    requestFn: request => { calls.push(request); return new Promise(resolve => { resolveRequest = resolve; }); },
  });
  const result = provider.dispatch({ workspace: "vault", targetWorkspace: "logical-target", token: "draft", prompt,
    canvasPath: "Board.canvas", selectedIds: ["n1"], systemPrompt: "Override", model: "gpt-4.1" });
  assert.equal(result.ok, true);
  assert.equal(provider.listTasks("vault")[0].status, "running");
  assert.deepEqual(notifications, ["running"]);
  const duplicate = provider.dispatch({ workspace: "vault", token: "draft", prompt });
  assert.equal(duplicate.id, result.id);
  assert.equal(duplicate.settled, result.settled);
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, "Bearer sample-secret");
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /\/v1\/chat\/completions$/);
  assert.match(prompt, /Edit this node/);
  assert.deepEqual(JSON.parse(calls[0].body), {
    model: "gpt-4.1", messages: [{ role: "system", content: "Override" }, { role: "user", content: prompt }],
    temperature: 0, max_tokens: 64,
  });
  const reply = '# Updated\n\n```canvas-patch\n{"updateNodes":[{"id":"n1","text":"done"}]}\n```';
  resolveRequest({ status: 200, json: jsonReply(reply) });
  const task = await result.settled;
  assert.deepEqual(notifications, ["running", "replied"]);
  assert.equal(task.status, "replied");
  assert.equal(task.reply, reply);
  assert.equal(task.model, "gpt-4.1");
  assert.equal(task.targetWorkspace, "logical-target");
  assert.deepEqual(task.selectedIds, ["n1"]);
  assert.ok(Date.parse(task.replyTime));
  assert.deepEqual(provider.listTasks("vault"), [task]);
  assert.equal((await provider.dispatch({ workspace: "vault", token: "draft" }).settled).status, "replied");
  assert.equal(calls.length, 1);
});

test("reruns a blocked task in place and deduplicates the pending request and its tokens", async () => {
  let saved;
  const persistence = { load: () => saved, save: value => { saved = JSON.parse(JSON.stringify(value)); } };
  const store = new LocalTaskStore(persistence);
  const requests = [];
  const notifications = [];
  let finish;
  const provider = createOpenAICompatibleProvider(config(), {
    store,
    notify: task => notifications.push([task.id, task.status]),
    requestFn: request => { requests.push(request); return new Promise(resolve => { finish = resolve; }); },
  });
  const workspace = "vault";
  const original = store.create(workspace, {
    executor: provider.id, status: "blocked", token: "original", model: "gpt-4.1-mini", prompt: "original prompt",
    time: "2026-01-01T00:00:00Z", replyTime: "2026-01-02T00:00:00Z", error: "Failed", reply: "Partial reply",
    canvasPath: "Board.canvas", selectedIds: ["node"],
  });
  const options = { workspace, rerunId: original.id, token: "retry", model: "gpt-4.1", prompt: "updated prompt" };
  const result = provider.dispatch(options);
  assert.equal(result.ok, true);
  assert.equal(result.id, original.id);
  const running = { ...original, status: "running", error: "", reply: "", replyTime: "", model: options.model, prompt: options.prompt };
  assert.deepEqual(provider.listTasks(workspace), [running]);
  for (const retry of [options, { ...options, token: "another-retry" }, { workspace, token: "original" }, { workspace, token: "retry" }]) {
    assert.deepEqual(provider.dispatch(retry), result);
  }
  const anotherProvider = createOpenAICompatibleProvider(config(), { store, requestFn: () => assert.fail("unexpected request") });
  assert.deepEqual(anotherProvider.dispatch(options), { ok: false, error: "该任务正在执行中。" });
  assert.equal(provider.dispatch({ ...options, workspace: "other-vault" }).ok, false);
  assert.deepEqual(provider.listTasks("other-vault"), []);
  await Promise.resolve();
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].body), {
    model: options.model, messages: [{ role: "user", content: options.prompt }],
  });
  finish({ status: 200, json: jsonReply("Done") });
  const replied = await result.settled;
  assert.ok(Date.parse(replied.replyTime));
  assert.deepEqual(replied, { ...running, status: "replied", reply: "Done", replyTime: replied.replyTime });
  assert.deepEqual(provider.listTasks(workspace), [replied]);
  assert.deepEqual(notifications, [[original.id, "running"], [original.id, "replied"]]);
  assert.deepEqual(await provider.dispatch(options).settled, replied);
  const restored = new LocalTaskStore(persistence);
  for (const token of ["original", "retry"]) {
    assert.deepEqual(restored.findByToken(workspace, provider.id, token), replied);
    assert.deepEqual(restored.create(workspace, { executor: provider.id, token }), replied);
  }
  assert.deepEqual(restored.list(workspace), [replied]);
  assert.equal(requests.length, 1);
});

test("sends no authorization to local servers, decodes text parts, and uses the sibling models endpoint", async () => {
  const requests = [];
  const provider = createOpenAICompatibleProvider(config({ baseUrl: "http://localhost:12345/v1/chat/completions/", systemPrompt: "Default system" }), {
    requestFn: request => {
      requests.push(request);
      return new Response(JSON.stringify(request.method === "GET" ? { data: [{ id: "local-model" }] }
        : jsonReply([{ type: "text", text: "one" }, { type: "text", text: " two" }])));
    },
  });
  assert.deepEqual(provider.capabilities, { modes: ["edit_canvas"], supportsEffort: false, supportsRepo: false });
  assert.equal(provider.getStatus().ready, true);
  assert.equal((await provider.dispatch({ prompt: "Hello" }).settled).reply, "one two");
  assert.deepEqual(await provider.testConnection(), { data: [{ id: "local-model" }] });
  assert.equal(requests[1].url, "http://localhost:12345/v1/models");
  for (const request of requests) assert.equal(Object.hasOwn(request.headers, "Authorization"), false);
  assert.deepEqual(JSON.parse(requests[0].body).messages, [{ role: "system", content: "Default system" }, { role: "user", content: "Hello" }]);
});

test("records status and error details for API, malformed response, network, and storage failures", async () => {
  const cases = [
    [() => ({ status: 429, json: { error: { message: "Rate limit" } } }), /HTTP 429: Rate limit/],
    [() => new Response("Unavailable", { status: 503 }), /HTTP 503: Unavailable/],
    [() => ({ status: 200, json: {} }), /HTTP 200: .*choices/],
    [() => ({ status: 200, get json() { throw new SyntaxError("Invalid JSON"); } }), /HTTP 200: .*Invalid JSON/],
    [async () => { throw new Error("Offline"); }, /Offline/],
    [() => ({ status: 401, json: { error: { message: "Invalid sample-secret" } } }), /HTTP 401: Invalid \[redacted\]/],
  ];
  for (const [requestFn, pattern] of cases) {
    const provider = createOpenAICompatibleProvider(config({ apiKey: "sample-secret" }), {
      requestFn, notify: async () => { throw new Error("Observer failed"); },
    });
    const task = await provider.dispatch({ workspace: "vault", prompt: "Test" }).settled;
    assert.equal(task.status, "blocked");
    assert.match(task.error, pattern);
    assert.ok(Date.parse(task.replyTime));
    assert.deepEqual(provider.listTasks("vault"), [task]);
  }

  let writes = 0;
  const store = new LocalTaskStore({ save: () => { if (++writes === 2) throw new Error("storage full"); } });
  const provider = createOpenAICompatibleProvider(config(), { store, requestFn: () => ({ status: 200, json: jsonReply("ok") }) });
  const blocked = await provider.dispatch({ workspace: "vault", prompt: "Test" }).settled;
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.error, /local storage/);
  assert.deepEqual(store.list("vault"), [blocked]);
  assert.equal(createOpenAICompatibleProvider(config({ models: [] })).getStatus().ready, false);
  assert.equal(createOpenAICompatibleProvider(config({ baseUrl: "ftp://example.test" })).getStatus().ready, false);
});

test("reports Test Connection errors and supports the standalone fetch transport", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    if (options.method === "POST") return new Response(JSON.stringify(jsonReply("Standalone reply")));
    return new Response(JSON.stringify({ error: { message: "model listing unavailable" } }), { status: 403 });
  });
  const provider = createOpenAICompatibleProvider(config({ baseUrl: "http://localhost:12345/v1" }));
  const result = await provider.dispatch({ prompt: "Standalone" }).settled;
  assert.equal(result.reply, "Standalone reply");
  await assert.rejects(provider.testConnection(), /HTTP 403: model listing unavailable/);
  assert.equal(requests[0].url, "http://localhost:12345/v1/chat/completions");
  assert.equal(requests[1].url, "http://localhost:12345/v1/models");

  const invalid = createOpenAICompatibleProvider(config(), { requestFn: () => ({ status: 200, json: { other: [] } }) });
  await assert.rejects(invalid.testConnection(), /HTTP 200: Models response did not contain a data array/);
});
