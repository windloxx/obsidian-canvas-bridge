const { randomUUID } = require("node:crypto");

const DEFAULT_SETTINGS = {
  enableBridge: true,
  openaiProviders: [{
    id: "openai-compatible",
    name: "OpenAI API",
    enabled: false,
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    models: ["gpt-4.1-mini", "gpt-4.1"],
    defaultModel: "gpt-4.1-mini",
    systemPrompt: "",
    temperature: null,
    maxTokens: null,
  }],
};

function parseModelList(text) {
  const values = Array.isArray(text) ? text : [text];
  return [...new Set(values.flatMap(value => typeof value === "string" ? value.split(/[\r\n,]/) : [])
    .map(value => value.trim()).filter(Boolean))];
}

const string = value => typeof value === "string" ? value.trim() : "";

function normalizeProvider(source, index) {
  source = source && typeof source === "object" ? source : {};
  const defaults = DEFAULT_SETTINGS.openaiProviders[0];
  const preferred = string(source.defaultModel);
  const models = parseModelList(source.models ?? (preferred ? [preferred] : defaults.models));
  const id = string(source.id).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
    || `openai-provider-${index + 1}`;
  return {
    id, name: string(source.name) || id, enabled: source.enabled === true,
    baseUrl: typeof source.baseUrl === "string" ? source.baseUrl.trim() : defaults.baseUrl,
    apiKey: string(source.apiKey),
    models, defaultModel: models.includes(preferred) ? preferred : models[0] || "",
    systemPrompt: typeof source.systemPrompt === "string" ? source.systemPrompt : "",
    temperature: Number.isFinite(source.temperature) ? source.temperature : null,
    maxTokens: Number.isInteger(source.maxTokens) && source.maxTokens > 0 ? source.maxTokens : null,
  };
}

function normalizeSettings(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const candidates = Array.isArray(source.openaiProviders) ? source.openaiProviders : DEFAULT_SETTINGS.openaiProviders;
  const used = new Set(["agy", "codex"]);
  const openaiProviders = Array.from(candidates, (item, index) => {
    const provider = normalizeProvider(item, index);
    let id = provider.id;
    let suffix = 2;
    while (used.has(id)) id = `${provider.id}-${suffix++}`;
    provider.id = id;
    used.add(id);
    return provider;
  });
  return { enableBridge: source.enableBridge !== false, openaiProviders };
}

function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") throw new TypeError("Provider adapter must be an object.");
  if (typeof adapter.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(adapter.id)) {
    throw new TypeError("Provider adapter id must be a lowercase slug.");
  }
  if (typeof adapter.label !== "string" || !adapter.label.trim()) throw new TypeError("Provider adapter label is required.");
  for (const method of ["getStatus", "listTasks", "dispatch"]) {
    if (typeof adapter[method] !== "function") throw new TypeError(`Provider adapter ${method} is required.`);
  }
  return adapter;
}

class ProviderRegistry {
  constructor() { this.adapters = new Map(); }
  register(adapter) { validateAdapter(adapter); this.adapters.set(adapter.id, adapter); return adapter; }
  unregister(id) { return this.adapters.delete(id); }
  get(id) { return this.adapters.get(id); }
  list() { return Array.from(this.adapters.values()); }
  listEnabled() { return this.list().filter(adapter => adapter.enabled !== false); }
}

function taskShape(task) {
  return {
    id: String(task.id), executor: task.executor || "",
    providerLabel: task.providerLabel || "",
    mode: task.mode || "execute_task", canvasPath: task.canvasPath || "",
    selectedIds: Array.isArray(task.selectedIds) ? [...task.selectedIds] : [],
    targetWorkspace: task.targetWorkspace || "",
    status: task.status || "running", prompt: task.prompt || "", reply: task.reply || "",
    time: task.time || new Date().toISOString(), replyTime: task.replyTime || "",
    error: task.error || "", model: task.model || "", source: task.source || "",
  };
}

class LocalTaskStore {
  constructor({ load, save, limit = 30 } = {}) {
    this.save = typeof save === "function" ? save : () => {};
    this.limit = Number.isInteger(limit) && limit > 0 ? limit : 30;
    const value = load?.();
    const entries = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : [];
    this.data = new Map(entries.filter(([, tasks]) => Array.isArray(tasks)).map(([workspace, tasks]) => [
      workspace, tasks.filter(task => task?.id != null).slice(0, this.limit),
    ]));
  }

  list(workspace, executor) {
    return (this.data.get(workspace) || []).filter(task => !executor || task.executor === executor).map(taskShape);
  }

  findByToken(workspace, executor, token) {
    if (!token) return undefined;
    const task = this.data.get(workspace)?.find(task => task.executor === executor && task.token === token);
    return task && taskShape(task);
  }

  persist(workspace, tasks) {
    const data = new Map(this.data).set(workspace, tasks);
    this.save(Object.fromEntries(data));
    this.data = data;
  }

  create(workspace, task) {
    const existing = this.findByToken(workspace, task.executor, task.token);
    if (existing) return existing;
    const value = taskShape({ ...task, id: task.id ?? randomUUID(), targetWorkspace: task.targetWorkspace || workspace });
    const tasks = [{ ...value, token: task.token }, ...(this.data.get(workspace) || [])];
    tasks.sort((a, b) => new Date(b.time) - new Date(a.time));
    this.persist(workspace, tasks.slice(0, this.limit));
    return taskShape(value);
  }

  update(workspace, id, patch, executor) {
    const tasks = this.data.get(workspace) || [];
    const index = tasks.findIndex(task => task.id === id && (!executor || task.executor === executor));
    if (index < 0) return undefined;
    const current = tasks[index];
    const updated = taskShape({ ...current, ...patch, id: current.id, executor: current.executor, time: current.time });
    const next = tasks.slice();
    next[index] = { ...updated, token: current.token };
    try {
      this.persist(workspace, next);
      return taskShape(updated);
    } catch {
      const blocked = { ...updated, status: "blocked", error: "Unable to save the completed task to local storage." };
      next[index] = { ...blocked, token: current.token };
      this.data.set(workspace, next);
      return taskShape(blocked);
    }
  }
}

function normalizeChatCompletionsUrl(baseUrl) {
  let url;
  try { url = new URL(string(baseUrl)); } catch { throw new Error("Base URL must be a valid http:// or https:// URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Base URL must use http:// or https://.");
  const pathname = url.pathname.replace(/\/+$/, "");
  if (!/\/chat\/completions$/.test(pathname)) url.pathname = `${pathname}/chat/completions`;
  else url.pathname = pathname;
  return url.toString();
}

function modelsUrl(baseUrl) {
  const url = new URL(normalizeChatCompletionsUrl(baseUrl));
  url.pathname = url.pathname.replace(/\/chat\/completions$/, "/models");
  return url.toString();
}

function extractChatCompletionReply(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  const reply = Array.isArray(content) ? content.filter(part => part?.type === "text").map(part => stringOrEmpty(part.text)).join("") : content;
  if (typeof reply === "string" && reply.trim()) return reply;
  throw new Error("Chat completion response did not contain text in choices[0].message.content.");
}

function stringOrEmpty(value) { return typeof value === "string" ? value : ""; }

async function readResponse(response, extract) {
  const status = response?.status;
  if (!Number.isInteger(status)) throw new Error("Invalid HTTP response (missing status).");
  let body;
  try {
    const text = typeof response.text === "function" ? await response.text() : response.text;
    if (typeof text === "string" && text.length) {
      try { body = JSON.parse(text); } catch { body = { text }; }
    } else {
      body = typeof response.json === "function" ? await response.json() : response.json ?? response.body;
    }
  } catch (error) {
    throw new Error(`HTTP ${status}: Unable to read the response (${error.message}).`);
  }
  const errorMessage = body?.error?.message || body?.error || body?.message || body?.text;
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}: ${string(errorMessage) || "Request failed."}`);
  try { return extract(body); }
  catch (error) { throw new Error(`HTTP ${status}: ${string(errorMessage) || error.message}`); }
}

function createOpenAICompatibleProvider(config, { store = new LocalTaskStore(), requestFn, notify } = {}) {
  const provider = normalizeProvider(config, 0);
  const { id, name: label, apiKey, baseUrl, models, defaultModel, enabled } = provider;
  const auth = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const pending = new Map();
  const request = requestFn || (({ url, method, headers, body }) => globalThis.fetch(url, { method, headers, body }));
  const redact = value => apiKey ? value.split(apiKey).join("[redacted]") : value;
  const errorText = error => redact(error?.message || String(error));

  function emit(task) {
    try { void Promise.resolve(notify?.(task)).catch(() => {}); }
    catch { /* Observers cannot change task state. */ }
  }

  async function complete(task, options) {
    const systemPrompt = options.systemPrompt || provider.systemPrompt;
    const messages = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: task.prompt });
    const body = { model: task.model, messages };
    const temperature = options.temperature ?? provider.temperature;
    const maxTokens = options.maxTokens ?? provider.maxTokens;
    if (temperature != null) body.temperature = temperature;
    if (maxTokens != null) body.max_tokens = maxTokens;
    const response = await request({
      url: normalizeChatCompletionsUrl(baseUrl), method: "POST",
      headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return redact(await readResponse(response, extractChatCompletionReply));
  }

  function dispatch(options = {}) {
    const workspace = options.workspace || options.targetWorkspace || "default";
    const existing = store.findByToken(workspace, id, options.token);
    if (existing) return { ok: true, id: existing.id, settled: pending.get(existing.id) || Promise.resolve(existing) };
    const task = store.create(workspace, {
      executor: id, providerLabel: label, mode: options.mode || "edit_canvas", canvasPath: options.canvasPath,
      selectedIds: options.selectedIds, targetWorkspace: options.targetWorkspace || workspace, status: "running",
      prompt: options.prompt ?? options.text ?? "", model: options.model || defaultModel,
      source: options.source || "Obsidian", token: options.token,
    });
    const settled = Promise.resolve().then(async () => {
      let patch;
      try { patch = { status: "replied", reply: await complete(task, options) }; }
      catch (error) { patch = { status: "blocked", error: errorText(error) }; }
      patch.replyTime = new Date().toISOString();
      try { return store.update(workspace, task.id, patch, id) || { ...task, ...patch }; }
      catch (error) { return { ...task, ...patch, status: "blocked", error: errorText(error) }; }
    }).then(updated => {
      pending.delete(task.id);
      emit(updated);
      return updated;
    });
    pending.set(task.id, settled);
    emit(task);
    return { ok: true, id: task.id, settled };
  }

  return {
    id, label, kind: "http", enabled, capabilities: { modes: ["edit_canvas"], supportsEffort: false, supportsRepo: false },
    getStatus: () => {
      try {
        normalizeChatCompletionsUrl(baseUrl);
        if (!defaultModel) throw new Error("请在 Canvas Bridge 设置中填写至少一个模型。");
        return { ready: true, models: [...models], defaultModel };
      } catch (error) { return { ready: false, message: error.message }; }
    },
    listTasks: workspace => store.list(workspace, id), dispatch,
    testConnection: async () => {
      try {
        const response = await request({ url: modelsUrl(baseUrl), method: "GET", headers: auth });
        return await readResponse(response, body => {
          if (!Array.isArray(body?.data)) throw new Error("Models response did not contain a data array.");
          return body;
        });
      } catch (error) { throw new Error(errorText(error)); }
    },
  };
}

module.exports = {
  DEFAULT_SETTINGS, parseModelList, normalizeSettings, ProviderRegistry, LocalTaskStore,
  normalizeChatCompletionsUrl, extractChatCompletionReply, createOpenAICompatibleProvider,
};

