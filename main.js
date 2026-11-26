const {
  Component, ItemView, MarkdownRenderer, Notice, Plugin, PluginSettingTab, Scope, Setting, requestUrl, setIcon,
} = require("obsidian");
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const { createHash, randomUUID } = crypto;
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LOCAL_BUILTINS = { "node:crypto": crypto, crypto, "node:path": path, path };

function loadLocalModule(pluginDir, name, builtins) {
  const filename = path.join(pluginDir, name);
  const source = fs.readFileSync(filename, "utf8");
  const mod = { exports: {} };
  const localRequire = id => {
    if (!Object.hasOwn(builtins, id)) throw new Error(`${name} cannot require ${id}`);
    return builtins[id];
  };
  new Function("module", "exports", "require", "__filename", "__dirname", source)(
    mod, mod.exports, localRequire, filename, pluginDir,
  );
  return mod.exports;
}

const VIEW = "obsidian-canvas-bridge";
const DRAFT = `${VIEW}:draft`;
const APPLIED = `${VIEW}:applied`;
const AUTO_CAPTURE = `${VIEW}:auto-capture`;
const MODEL_PREFS = `${VIEW}:models`;
const PROVIDER_TASKS = `${VIEW}:provider-tasks`;
const EXECUTORS = { agy: "AGY", codex: "Codex" };
const MODES = { edit_canvas: "改选区画布", execute_task: "执行任务" };
const BRIDGE_CAPABILITIES = { modes: Object.keys(MODES), supportsRepo: true };
const PROVIDER_GUIDANCE = "请在设置 → Canvas Bridge 启用 OpenAI 兼容服务，或安装并启用 Codex-Antigravity-Bridge。";
const STATUS = {
  queued: "等待领取", notified: "已通知", claimed: "已领取", running: "执行中", replied: "已回复",
  blocked: "受阻", notification_failed: "通知失败", cancelled: "已取消",
};
const DECISION = {
  REWORK_REQUIRED: "需要返工", ESCALATE_TO_PRODUCER: "需要决定",
};
const timeFormat = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : timeFormat.format(date);
}

function iconButton(parent, icon, label) {
  const button = parent.createEl("button", {
    cls: "clickable-icon", attr: { type: "button", "aria-label": label, title: label },
  });
  setIcon(button, icon);
  return button;
}

function segmentGroup(parent, label) {
  return parent.createDiv({ cls: "bc-segment", attr: { role: "group", "aria-label": label } });
}

function segmentButtons(group, options, onChange) {
  group.empty();
  group.hidden = !options.length;
  return options.map(([value, text]) => {
    const button = group.createEl("button", { text, attr: { type: "button" } });
    button.onclick = () => onChange(value);
    return [value, button];
  });
}

function selectionIds(selection) {
  if (!selection || typeof selection[Symbol.iterator] !== "function") return [];
  return Array.from(selection, item => typeof item === "string" ? item : item?.id)
    .filter(id => typeof id === "string" && id.length > 0);
}

function selectionSignature(canvasPath, ids) {
  return `${canvasPath}\0${[...ids].sort().join(",")}`;
}

function loadModelPrefs(app) {
  const raw = app.loadLocalStorage(MODEL_PREFS);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { agy: "", codex: "", codexEffort: "" };
  }
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => typeof value === "string"));
}

function fillSelect(select, options, selectedValue) {
  select.empty?.();
  if (typeof select.replaceChildren === "function" && !select.empty) select.replaceChildren();
  for (const item of options) {
    const opt = select.createEl
      ? select.createEl("option", { text: item.label, attr: { value: item.value, title: item.title || item.value } })
      : { value: item.value, text: item.label, title: item.title || item.value };
    if (!select.createEl && Array.isArray(select.options)) select.options.push(opt);
  }
  select.value = selectedValue;
}

function canvasPathOf(leaf) {
  return leaf.view.file?.path || leaf.getViewState?.()?.state?.file || "";
}

function validateCanvasData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)
      || (data.nodes !== undefined && !Array.isArray(data.nodes))
      || (data.edges !== undefined && !Array.isArray(data.edges))) {
    throw new Error("无法读取 Canvas 节点或连线数据。");
  }
  for (const item of [...(data.nodes || []), ...(data.edges || [])]) {
    if (!item || typeof item.id !== "string") throw new Error("Canvas 中存在缺少 ID 的节点或连线。");
  }
  return data;
}

function readCanvasView(view) {
  let liveError;
  try {
    const data = view.canvas?.getData?.();
    if (data != null) return validateCanvasData(data);
  } catch (error) {
    liveError = error;
  }
  if (typeof view.getViewData === "function") return validateCanvasData(JSON.parse(view.getViewData()));
  throw liveError || new Error("当前 Canvas 无法读取选区数据。");
}

function taskCanvas(task, metadata) {
  const executor = task.executor || "agy";
  if (executor === "agy") {
    return task.source === "Obsidian" && metadata?.executor === "agy" && typeof metadata.canvasPath === "string"
      ? metadata : {};
  }
  if (executor === "codex") return task;
  return {
    canvasPath: typeof task.canvasPath === "string" && task.canvasPath ? task.canvasPath : metadata?.canvasPath,
    selectedIds: Array.isArray(task.selectedIds) ? task.selectedIds : metadata?.selectedIds,
    mode: task.mode || metadata?.mode,
  };
}

function taskKey(task) {
  return `${task.executor || "agy"}:${task.id}`;
}

function patchCounts({
  updated, addedNodes, addedEdges, removedNodes, updatedEdges = 0, removedEdges = 0, skipped = 0,
}) {
  const edgeOps = addedEdges + updatedEdges + removedEdges;
  return `更新 ${updated} · 新增 ${addedNodes} · 删除 ${removedNodes} · 连线 ${edgeOps}${skipped ? ` · 跳过 ${skipped}` : ""}`;
}

function revertCounts({ restoredNodes = 0, removedNodes = 0, restoredEdges = 0, removedEdges = 0 }) {
  return `还原 ${restoredNodes} 节点 · 移除 ${removedNodes} 新增 · 还原 ${restoredEdges} 连线 · 移除 ${removedEdges} 新增连线`;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function patchPreview(patch) {
  return patchCounts({
    updated: patch.updateNodes?.length || 0, addedNodes: patch.addNodes?.length || 0,
    removedNodes: patch.removeNodeIds?.length || 0, addedEdges: patch.addEdges?.length || 0,
    updatedEdges: patch.updateEdges?.length || 0, removedEdges: patch.removeEdgeIds?.length || 0,
  });
}

async function bridgeRegistration() {
  const config = path.join(os.homedir(), ".gemini", "config", "mcp_config.json");
  const data = JSON.parse((await fs.promises.readFile(config, "utf8")).replace(/^\uFEFF/, ""));
  const entry = data.mcpServers?.["chatgpt-bridge"];
  const server = entry?.args?.find(arg => path.basename(arg) === "bridge_server.py");
  if (!entry?.command || !path.isAbsolute(entry.command) || !server || !path.isAbsolute(server)) {
    throw new Error("请检查 Antigravity 中的 chatgpt-bridge 本机配置。");
  }
  return { python: entry.command, server, bus: path.join(path.dirname(server), "bus") };
}

function callBridge(registration, helper, workspace, payload) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      registration.python, ["-I", "-B", "-X", "utf8", helper, registration.server],
      { cwd: workspace, windowsHide: true, encoding: "utf8", timeout: 24000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error(error.killed ? "本机桥接响应超时，请刷新记录。" : `无法启动本机桥接：${error.message}`));
          return;
        }
        try {
          const result = JSON.parse(stdout);
          if (!result.ok) throw new Error(result.error || "本机桥接未完成请求。");
          resolve(result);
        } catch (problem) {
          reject(problem);
        }
      },
    );
    child.stdin.on("error", reject);
    child.stdin.end(JSON.stringify({ ...payload, workspace }), "utf8");
  });
}

async function requestHttp({ url, method, headers, body }) {
  if (typeof requestUrl === "function") return requestUrl({ url, method, headers, body, throw: false });
  if (typeof globalThis.fetch === "function") return globalThis.fetch(url, { method, headers, body });
  throw new Error("当前环境无法发送 HTTP 请求。");
}

async function renderMarkdown(view, markdown, container, sourcePath) {
  const source = sourcePath || "";
  const renderPlainText = () => {
    container.classList?.remove("markdown-rendered");
    container.setText(markdown);
  };
  if (typeof MarkdownRenderer?.render !== "function") return renderPlainText();
  try {
    await MarkdownRenderer.render(view.app, markdown, container, source, view.renderComponent || view);
  } catch {
    return renderPlainText();
  }
  container.addEventListener?.("click", event => {
    const link = event.target?.closest?.("a.internal-link");
    const href = link?.getAttribute("data-href") || link?.getAttribute("href");
    if (!href || typeof view.app.workspace.openLinkText !== "function") return;
    event.preventDefault();
    event.stopPropagation();
    void view.app.workspace.openLinkText?.(href, source);
  }, true);
}

function addRawDetails(container, label, text) {
  const raw = container.createEl("details", { cls: "bc-raw" });
  raw.createEl("summary", { text: label });
  raw.createEl("pre", { text });
}

const CARD_TYPES = { text: "文本", file: "笔记", group: "分组", link: "链接" };

function addMiniCard(container, { badge, color, geometry, kind, op }) {
  const card = container.createDiv({ cls: "bc-mini-card" });
  if (kind) card.dataset.kind = kind;
  if (op) card.dataset.op = op;
  if (typeof color === "string" && /^[1-6]$|^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) {
    card.dataset.color = color;
    if (color.startsWith("#")) card.style.setProperty("--bc-node-color", color);
  }
  const header = card.createDiv({ cls: "bc-card-header" });
  header.createSpan({ cls: "bc-badge", text: badge });
  if (geometry) header.createSpan({ cls: "bc-card-geometry", text: geometry });
  return { card, header };
}

function addNoteLink(view, container, file, sourcePath) {
  const link = container.createEl("a", { cls: "internal-link", text: file, attr: { href: "#", "data-href": file } });
  link.onclick = event => {
    event.preventDefault();
    event.stopPropagation();
    void view.app.workspace.openLinkText?.(file, sourcePath || "");
  };
}

function addExternalLink(container, url) {
  if (/^https?:\/\//i.test(url)) {
    container.createEl("a", { cls: "external-link", text: url, attr: { href: url, target: "_blank", rel: "noopener noreferrer" } });
  } else {
    container.createSpan({ text: url });
  }
}

function addSelectionCard(view, grid, node, canvasPath) {
  const { x, y, width, height } = node;
  const geometry = [Number.isFinite(width) && Number.isFinite(height) && `${width}×${height}`,
    Number.isFinite(x) && Number.isFinite(y) && `(${x}, ${y})`].filter(Boolean).join(" · ");
  const badge = Object.hasOwn(CARD_TYPES, node.type) ? CARD_TYPES[node.type] : "节点";
  const { card, header } = addMiniCard(grid, { badge, geometry, color: node.color });
  if (canvasPath && node.id) {
    const locate = header.createEl("button", { cls: "bc-card-focus", text: "定位", attr: { type: "button" } });
    locate.onclick = () => view.plugin.focusCanvasNode(canvasPath, node.id);
  }
  const body = card.createDiv({ cls: "bc-card-body" });
  if (node.type === "text" && typeof node.text === "string" && node.text) {
    void renderMarkdown(view, node.text, body.createDiv({ cls: "markdown-rendered" }), canvasPath);
  } else if (node.type === "file" && typeof node.file === "string" && node.file) {
    addNoteLink(view, body, node.file, canvasPath);
    if (typeof node.fileExcerpt === "string" && node.fileExcerpt) {
      const excerpt = body.createEl("details", { cls: "bc-raw" });
      excerpt.createEl("summary", { text: "查看文件摘录" });
      void renderMarkdown(view, node.fileExcerpt, excerpt.createDiv({ cls: "markdown-rendered" }), node.file);
    }
  } else if (node.type === "link" && typeof node.url === "string" && node.url) {
    addExternalLink(body, node.url);
  } else if (node.type === "group" && typeof node.label === "string") {
    body.setText(node.label);
  }
}

function addTaskPrompt(view, body, prompt, parsed, canvasPath) {
  if (!parsed) {
    body.createDiv({ cls: "bc-prompt", text: prompt });
    return;
  }
  body.createDiv({ cls: "bc-user-instruction", text: parsed.instruction });
  const { internalEdges, incomingEdges, outgoingEdges } = parsed;
  if (internalEdges.length || incomingEdges.length || outgoingEdges.length) {
    body.createDiv({ cls: "bc-edge-summary", text: `内部 ${internalEdges.length} · 上游 ${incomingEdges.length} · 下游 ${outgoingEdges.length}` });
  }
  if (parsed.nodes.length) {
    const grid = body.createDiv({ cls: "bc-card-grid" });
    for (const node of parsed.nodes) {
      if (node && typeof node === "object" && !Array.isArray(node)) addSelectionCard(view, grid, node, canvasPath);
    }
  }
  addRawDetails(body, "查看原始 Prompt", prompt);
}

function isPatchError(patch) {
  return typeof patch.error === "string" && Object.keys(patch).length === 1;
}

function addPatchCard(view, cards, item, canvasPath) {
  const { card, header } = addMiniCard(cards, item);
  if (Object.hasOwn(CARD_TYPES, item.nodeType)) header.createSpan({ text: CARD_TYPES[item.nodeType] });
  const body = card.createDiv({ cls: "bc-card-body" });
  if (item.kind === "edge") {
    const from = [item.fromLabel, item.fromSide].filter(Boolean).join(" · ");
    const to = [item.toLabel, item.toSide].filter(Boolean).join(" · ");
    if (from || to) body.createDiv({ text: `${from || "?"} → ${to || "?"}` });
    if (typeof item.label === "string" && item.label) body.createDiv({ cls: "bc-card-label", text: item.label });
    return;
  }
  if (item.title) body.createDiv({ cls: "bc-card-title", text: item.title });
  if (typeof item.markdown === "string" && item.markdown) {
    void renderMarkdown(view, item.markdown, body.createDiv({ cls: "markdown-rendered" }), canvasPath);
  }
  if (typeof item.file === "string" && item.file) addNoteLink(view, body, item.file, canvasPath);
  if (typeof item.url === "string" && item.url) addExternalLink(body, item.url);
}

function addReplyContent(view, reply, task, parsed, canvasPath) {
  const context = view.plugin.canvasContext;
  const { bodyMarkdown, patch, rawPatchJson } = context?.splitReplyAndPatch(task.reply)
    ?? { bodyMarkdown: String(task.reply || "") };
  if (bodyMarkdown) {
    const answer = reply.createDiv({ cls: "bc-answer markdown-rendered" });
    void renderMarkdown(view, bodyMarkdown, answer, canvasPath);
  }
  if (patch) {
    if (!isPatchError(patch)) {
      const edges = parsed ? [...parsed.internalEdges, ...parsed.incomingEdges, ...parsed.outgoingEdges] : [];
      const items = context.buildPatchPreviewItems(patch, parsed?.nodes || [], edges);
      const cards = reply.createDiv({ cls: "bc-patch-cards" });
      for (const item of items) addPatchCard(view, cards, item, canvasPath);
    }
    addRawDetails(reply, "查看 Patch JSON", rawPatchJson);
  }
  return patch;
}

function addTask(view, task, open) {
  const parsed = view.plugin.canvasContext?.parseCanvasPromptEnvelope(task.prompt);
  const context = taskCanvas(task, parsed?.metadata);
  const canvasPath = context.canvasPath || (typeof parsed?.metadata.canvasPath === "string" ? parsed.metadata.canvasPath : "");
  const mode = context.mode || parsed?.metadata.mode;
  const executor = task.providerLabel || view.plugin.providerLabel(task.executor) || "AGY";
  const details = view.list.createEl("details", { cls: "bc-task" });
  details.dataset.request = task.id;
  details.dataset.taskKey = taskKey(task);
  details.dataset.status = task.status;
  details.open = open;
  const summary = details.createEl("summary");
  const meta = summary.createSpan({ cls: "bc-meta" });
  meta.createSpan({ cls: "bc-badge", text: executor });
  if (task.source) meta.createSpan({ cls: "bc-source", text: task.source });
  const sent = meta.createEl("time", { text: formatTime(task.time) });
  sent.title = task.time;
  meta.createSpan({ cls: "bc-status", text: STATUS[task.status] || task.status });
  if (canvasPath) {
    const tag = summary.createDiv({ cls: "bc-task-canvas", text: `${MODES[mode] || "Canvas"} · ${path.basename(canvasPath)}` });
    tag.title = canvasPath;
  }
  const preview = summary.createSpan({ cls: "bc-preview" });
  preview.createSpan({ text: parsed?.instruction ?? task.prompt });
  setIcon(preview.createSpan({ cls: "bc-chevron" }), "chevron-down");
  const body = details.createDiv({ cls: "bc-body" });
  addTaskPrompt(view, body, task.prompt, parsed, canvasPath);
  if (task.status === "replied") {
    const reply = body.createDiv({ cls: "bc-reply" });
    const heading = reply.createDiv({ cls: "bc-reply-heading" });
    setIcon(heading.createSpan(), "corner-down-right");
    heading.createSpan({ text: task.providerLabel || ((task.executor || "agy") === "agy" ? "Antigravity" : executor) });
    if (task.model) heading.createSpan({ cls: "bc-task-canvas", text: task.model });
    const at = heading.createEl("time", { text: formatTime(task.replyTime) });
    at.title = task.replyTime;
    if (DECISION[task.decision]) reply.createDiv({ cls: "bc-decision", text: DECISION[task.decision] });
    const patch = addReplyContent(view, reply, task, parsed, canvasPath);
    if (task.next && task.next.trim().toUpperCase() !== "NONE") {
      const next = reply.createEl("details", { cls: "bc-next" });
      next.createEl("summary", { text: "后续指示" });
      next.createDiv({ text: task.next });
    }
    view.addPatchActions(reply, task, { canvasPath: context.canvasPath, selectedIds: context.selectedIds, patch });
  }
  if (task.error) body.createDiv({ cls: "bc-task-error", text: task.error });
}

class BridgeView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.active = false;
    this.sending = false;
    this.refreshAgain = false;
    this.signature = null;
    this.renderComponent = null;
    this.latest = null;
    this.executor = "agy";
    this.mode = "edit_canvas";
    this.autoCapture = true;
    this.lastAutoSignature = "";
    this.repoManual = false;
    this.modelPrefs = { agy: "", codex: "", codexEffort: "" };
    this.modelOptionsKey = "";
    this.effortOptionsKey = "";
    this.captureVersion = 0;
    this.providerStates = new Map();
    this.providerSubscriptions = new Map();
    this.providerRefreshVersion = 0;
    this.tasks = [];
    this.scope = new Scope(this.app.scope);
    this.scope.register(["Mod"], "Enter", event => {
      if (event.target !== this.input || event.isComposing || event.keyCode === 229) return;
      if (!event.repeat) void this.send();
      return false;
    });
  }

  getViewType() { return VIEW; }
  getDisplayText() { return "协作对话"; }
  getIcon() { return "messages-square"; }

  async onOpen() {
    this.active = true;
    this.signature = null;
    this.latest = null;
    this.tasks = [];
    this.providerTasks = [];
    this.providerDiscoveryComplete = false;
    this.autoCapture = this.app.loadLocalStorage(AUTO_CAPTURE) !== false;
    this.lastAutoSignature = "";
    this.repoManual = false;
    this.modelPrefs = loadModelPrefs(this.app);
    this.modelOptionsKey = "";
    this.effortOptionsKey = "";
    this.executorKey = null;
    this.modeKey = null;
    this.workspacePath = this.app.vault.adapter.getBasePath();
    if (!this.plugin.ensureCanvasContext() && this.plugin.canvasLoadError) {
      new Notice(`无法加载 Canvas 协作模块 · ${this.plugin.canvasLoadError}`);
    }
    const saved = this.app.loadLocalStorage(DRAFT);
    this.draft = saved?.token && typeof saved.text === "string" ? saved : { token: randomUUID(), text: "" };
    this.contentEl.empty();
    this.contentEl.addClass("bridge-chat");
    const header = this.contentEl.createDiv({ cls: "bc-header" });
    const target = header.createDiv({ cls: "bc-target" });
    const title = target.createDiv({ cls: "bc-title" });
    title.createSpan({ text: "协作对话" });
    this.indicator = title.createSpan({ cls: "bc-connection", text: "正在连接" });
    this.vaultLabel = target.createDiv({ cls: "bc-vault", text: this.app.vault.getName() });
    const refresh = iconButton(header, "refresh-cw", "刷新服务和指令");
    refresh.onclick = async () => { await this.plugin.probeBridge(); await this.refresh(); };
    const historyLabel = this.contentEl.createDiv({ cls: "bc-section", text: "最近指令" });
    this.count = historyLabel.createSpan({ cls: "bc-count" });
    this.list = this.contentEl.createDiv({ cls: "bc-list", attr: { "aria-label": "最近指令" } });
    this.form = this.contentEl.createEl("form", { cls: "bc-composer" });
    this.buildCanvasControls();
    this.feedback = this.form.createDiv({ cls: "bc-feedback", attr: { role: "status", "aria-live": "polite" } });
    this.input = this.form.createEl("textarea", { attr: { rows: "3", "aria-label": "协作指令" } });
    this.input.value = this.draft.text;
    const actions = this.form.createDiv({ cls: "bc-actions" });
    actions.createEl("small", { text: "Ctrl + Enter 发送" });
    this.submit = actions.createEl("button", { cls: "mod-cta bc-send", attr: { type: "submit" } });
    setIcon(this.submit.createSpan(), "send-horizontal");
    this.submitText = this.submit.createSpan({ text: "发送指令" });
    this.form.onsubmit = event => { event.preventDefault(); void this.send(); };
    this.input.oninput = () => {
      this.draft = { token: randomUUID(), text: this.input.value };
      this.app.saveLocalStorage(DRAFT, this.draft);
      this.updateButton();
    };
    this.registerDomEvent(window, "focus", () => {
      this.refresh();
      this.scheduleAutoCapture();
    });
    if (typeof document !== "undefined") {
      this.registerDomEvent(document, "pointerup", () => this.scheduleAutoCapture());
      this.registerDomEvent(document, "keyup", () => this.scheduleAutoCapture());
    }
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scheduleAutoCapture()));
    this.plugin.openViews.add(this);
    this.updateComposer();
    this.scheduleAutoCapture(0);
    await this.refresh();
  }

  buildCanvasControls() {
    const controls = this.form.createDiv({ cls: "bc-compose-options" });
    this.executorGroup = segmentGroup(controls, "执行者");
    this.modeGroup = segmentGroup(controls, "Canvas 模式");
    this.executorButtons = [];
    this.modeButtons = [];
    this.modelBar = this.form.createDiv({ cls: "bc-model-bar" });
    this.modelWrap = this.modelBar.createEl("label", { cls: "bc-model-wrap" });
    this.modelWrap.createSpan({ text: "模型" });
    this.modelSelect = this.modelWrap.createEl("select", { cls: "bc-model-select dropdown", attr: { "aria-label": "选择模型" } });
    this.modelSelect.onchange = () => this.onModelChange();
    this.effortWrap = this.modelBar.createEl("label", { cls: "bc-effort-wrap" });
    this.effortWrap.createSpan({ text: "强度" });
    this.effortSelect = this.effortWrap.createEl("select", { cls: "bc-effort-select dropdown", attr: { "aria-label": "选择推理强度" } });
    this.effortSelect.onchange = () => this.onEffortChange();
    const bar = this.form.createDiv({ cls: "bc-selection" });
    const header = bar.createDiv({ cls: "bc-selection-header" });
    this.selectionLabel = header.createSpan({ cls: "bc-selection-label" });
    this.autoToggle = header.createEl("button", {
      cls: "bc-auto-toggle", text: "自动",
      attr: { type: "button", "aria-label": "自动抓取 Canvas 选区", title: "自动抓取 Canvas 选区（点击开启/暂停）" },
    });
    this.autoToggle.onclick = () => this.toggleAutoCapture();
    this.capture = iconButton(header, "scan", "抓取当前 Canvas 选区");
    this.capture.onclick = () => this.captureSelection();
    this.clear = iconButton(header, "x", "清除选区");
    this.clear.onclick = () => this.clearSelection();
    this.repoRow = bar.createEl("label", { cls: "bc-repo" });
    this.repoRow.createSpan({ text: "目标仓库" });
    this.repo = this.repoRow.createEl("input", {
      attr: { type: "text", placeholder: "留空使用当前 Vault", spellcheck: "false" },
    });
    this.repo.onkeydown = event => { if (event.key === "Enter") event.preventDefault(); };
    this.repo.oninput = () => { this.repoManual = true; this.sendError = ""; this.updateComposer(); };
  }

  setExecutor(executor) {
    if (this.executorGroup && !this.executorButtons.some(([id]) => id === executor)) return false;
    this.executor = executor;
    this.sendError = "";
    this.updateComposer();
    return true;
  }

  activeProvider() { return this.plugin.providers?.get(this.executor); }

  isBridgeExecutor() { return Object.hasOwn(EXECUTORS, this.executor); }

  capabilities() {
    return this.activeProvider()?.capabilities
      || (this.isBridgeExecutor() ? { ...BRIDGE_CAPABILITIES, supportsEffort: this.executor === "codex" } : { modes: [] });
  }

  syncProviderControls() {
    if (!this.executorGroup) return;
    const adapters = this.plugin.providers?.listEnabled() || [];
    const legacyRoute = this.route && !this.registration;
    const options = Object.entries(EXECUTORS).filter(([id]) => legacyRoute || !this.plugin.providers
      || adapters.some(adapter => adapter.id === id));
    for (const adapter of adapters) {
      if (Object.hasOwn(EXECUTORS, adapter.id)) continue;
      const status = this.providerStates.get(adapter.id);
      if (status?.adapter === adapter && status.value.available === false) continue;
      options.push([adapter.id, adapter.label]);
    }
    if (this.providerDiscoveryComplete && !options.some(([id]) => id === this.executor)) {
      this.executor = options.find(([id]) => this.providerStates.get(id)?.value.ready)?.[0] || options[0]?.[0] || "";
      this.sendError = "";
    }
    const executorKey = JSON.stringify(options);
    if (this.executorKey !== executorKey) {
      this.executorKey = executorKey;
      this.executorButtons = segmentButtons(this.executorGroup, options, value => this.setExecutor(value));
    }
    const modes = (this.capabilities().modes || []).map(id => [id, Object.hasOwn(MODES, id) ? MODES[id] : id]);
    if (!modes.some(([id]) => id === this.mode)) this.mode = modes[0]?.[0] || "";
    const modeKey = JSON.stringify(modes);
    if (this.modeKey !== modeKey) {
      this.modeKey = modeKey;
      this.modeButtons = segmentButtons(this.modeGroup, modes, value => { this.mode = value; this.updateComposer(); });
    }
  }

  codexModels() {
    return Array.isArray(this.route?.codex_models) ? this.route.codex_models : [];
  }

  agyModels() {
    return Array.isArray(this.route?.agy_models) ? this.route.agy_models : [];
  }

  selectedCodexModel() {
    const list = this.codexModels();
    const saved = this.modelPrefs?.codex;
    if (saved && list.some(item => item.id === saved)) return saved;
    if (this.route?.codex_model && (!list.length || list.some(item => item.id === this.route.codex_model))) {
      return this.route.codex_model;
    }
    return list[0]?.id || "";
  }

  selectedCodexEffort() {
    const modelId = this.selectedCodexModel();
    const entry = this.codexModels().find(item => item.id === modelId);
    const efforts = Array.isArray(entry?.efforts) ? entry.efforts : [];
    const saved = this.modelPrefs?.codexEffort;
    if (saved && (!efforts.length || efforts.includes(saved))) return saved;
    const def = this.route?.codex_default_effort || entry?.defaultEffort;
    if (def && (!efforts.length || efforts.includes(def))) return def;
    return efforts[0] || "";
  }

  selectedAgyModel() {
    const list = this.agyModels();
    const saved = this.modelPrefs?.agy;
    return saved && list.some(item => item.id === saved) ? saved : "";
  }

  providerStatus() {
    const status = this.providerStates.get(this.executor);
    return status?.adapter === this.activeProvider() ? status?.value : undefined;
  }

  selectedProviderModel() {
    const { models = [], defaultModel } = this.providerStatus() || {};
    const saved = this.modelPrefs[this.executor];
    return models.includes(saved) ? saved : models.includes(defaultModel) ? defaultModel : models[0] || "";
  }

  effortPrefKey() { return this.executor === "codex" ? "codexEffort" : `${this.executor}:effort`; }

  syncModelSelectors() {
    if (!this.modelSelect) return;
    const isCodex = this.executor === "codex";
    let options;
    let selected;
    if (isCodex) {
      const list = this.codexModels();
      options = list.map(m => ({ value: m.id, label: m.label || m.id, title: m.id }));
      if (!options.length && this.route?.codex_model) {
        options = [{ value: this.route.codex_model, label: this.route.codex_model, title: this.route.codex_model }];
      }
      selected = this.selectedCodexModel();
    } else if (this.executor === "agy") {
      const defaultHint = this.route?.agy_default_model ? `参考默认：${this.route.agy_default_model}` : "使用当前桌面对话默认模型";
      options = [
        { value: "", label: "跟随当前对话（默认）", title: defaultHint },
        ...this.agyModels().map(m => ({ value: m.id, label: m.label || m.id, title: m.id })),
      ];
      selected = this.selectedAgyModel();
    } else {
      options = (this.providerStatus()?.models || []).map(model => ({ value: model, label: model }));
      selected = this.selectedProviderModel();
    }
    if (this.modelWrap) this.modelWrap.hidden = !options.length;
    const modelKey = JSON.stringify([this.executor, options]);
    if (modelKey !== this.modelOptionsKey) {
      this.modelOptionsKey = modelKey;
      fillSelect(this.modelSelect, options, selected);
    } else if (this.modelSelect.value !== selected) {
      this.modelSelect.value = selected;
    }
    if (!this.effortWrap || !this.effortSelect) return;
    const entry = this.codexModels().find(item => item.id === selected);
    const offeredEfforts = isCodex ? entry?.efforts : this.providerStatus()?.efforts;
    const efforts = this.capabilities().supportsEffort && Array.isArray(offeredEfforts) ? offeredEfforts : [];
    this.effortWrap.hidden = !efforts.length;
    if (this.modelBar) this.modelBar.hidden = !options.length && !efforts.length;
    const effortOptions = efforts.map(e => ({ value: e, label: e, title: `推理强度 ${e}` }));
    const savedEffort = this.modelPrefs[this.effortPrefKey()];
    const selectedEffort = isCodex ? this.selectedCodexEffort() : efforts.includes(savedEffort) ? savedEffort : efforts[0] || "";
    const effortKey = JSON.stringify(effortOptions);
    if (effortKey !== this.effortOptionsKey) {
      this.effortOptionsKey = effortKey;
      fillSelect(this.effortSelect, effortOptions, selectedEffort);
    } else if (this.effortSelect.value !== selectedEffort) {
      this.effortSelect.value = selectedEffort;
    }
  }

  onModelChange() {
    if (!this.modelSelect) return;
    this.modelPrefs[this.executor] = this.modelSelect.value;
    this.app.saveLocalStorage(MODEL_PREFS, this.modelPrefs);
    this.updateComposer();
  }

  onEffortChange() {
    if (!this.effortSelect) return;
    this.modelPrefs[this.effortPrefKey()] = this.effortSelect.value;
    this.app.saveLocalStorage(MODEL_PREFS, this.modelPrefs);
    this.updateComposer();
  }

  toggleAutoCapture() {
    this.autoCapture = !this.autoCapture;
    this.app.saveLocalStorage(AUTO_CAPTURE, this.autoCapture);
    this.updateButton();
    if (this.autoCapture) {
      this.lastAutoSignature = "";
      this.scheduleAutoCapture(0);
    } else {
      window.clearTimeout(this.autoTimer);
    }
  }

  scheduleAutoCapture(delay = 140) {
    if (!this.active || !this.autoCapture || this.sending) return;
    window.clearTimeout(this.autoTimer);
    this.autoTimer = window.setTimeout(() => void this.syncAutoSelection(), delay);
  }

  async syncAutoSelection() {
    if (!this.active || !this.autoCapture || this.sending) return;
    const peek = this.plugin.peekCanvasSelection();
    if (!peek || peek.signature === this.lastAutoSignature) return;
    await this.captureSelection(undefined, { silent: true, preserveRepo: true, signature: peek.signature });
  }

  clearSelection() {
    const peek = this.plugin.peekCanvasSelection();
    this.lastAutoSignature = peek?.signature || "";
    this.setSelection(null);
  }

  setSelection(context, { preserveRepo = false } = {}) {
    this.captureVersion++;
    const sameCanvas = Boolean(context && this.context?.snapshot.canvasPath === context.snapshot.canvasPath);
    this.context = context;
    if (!preserveRepo || !this.repoManual || !sameCanvas) {
      this.repo.value = context?.snapshot.detectedRepo || "";
      this.repoManual = false;
    }
    this.sendError = "";
    this.updateComposer();
  }

  async captureSelection(hint, { silent = false, preserveRepo = false, signature = "" } = {}) {
    const version = ++this.captureVersion;
    try {
      const context = await this.plugin.getCanvasSelection(hint);
      if (!this.active || version !== this.captureVersion) return false;
      this.lastAutoSignature = signature || selectionSignature(context.snapshot.canvasPath, context.snapshot.directSelectedIds);
      this.setSelection(context, { preserveRepo });
      return true;
    } catch (error) {
      if (this.active && version === this.captureVersion && !silent) new Notice(error.message);
      return false;
    }
  }

  isReady() {
    if (this.isBridgeExecutor()) return this.executor === "codex" ? this.route?.codex_ready : this.route?.paired;
    const status = this.providerStatus();
    return Boolean(status?.ready && this.mode && this.activeProvider()?.enabled !== false);
  }

  updateComposer() {
    this.syncProviderControls();
    const state = this.route;
    const ready = Boolean(this.isReady());
    const isCodex = this.executor === "codex";
    const label = this.plugin.providerLabel(this.executor);
    const status = this.providerStatus();
    const hasProvider = Boolean(this.executor) && !this.isBridgeExecutor();
    const connection = isCodex ? (ready ? "Codex 就绪" : "Codex 未就绪") : (ready ? "AGY 已配对" : "AGY 待配对");
    const connectionText = hasProvider ? `${label} ${ready ? "就绪" : status ? "未就绪" : "正在连接"}`
      : state ? connection : this.bridgeError ? "连接中断" : this.executor ? "正在连接" : "没有可用的执行者";
    this.indicator.setText(connectionText);
    this.indicator.dataset.ready = String(ready);
    const codexModel = this.selectedCodexModel() || state?.codex_model;
    const agyModel = this.selectedAgyModel();
    this.vaultLabel.title = hasProvider ? this.workspacePath : isCodex
      ? [this.workspacePath, codexModel, this.selectedCodexEffort()].filter(Boolean).join("\n")
      : state?.paired
        ? `${this.workspacePath}\n项目 ${state.project}\n对话 ${state.conversation}${agyModel ? `\n指定模型 ${agyModel}` : ""}`
        : this.workspacePath;
    const routeError = this.isBridgeExecutor() && state && !ready && (isCodex
      ? state.codex_error || "请先在 Codex 路由设置中配置有效的 worker_profile.model。"
      : state.reason || "请在 Codex 中为本仓库配对 Antigravity 桌面对话。");
    this.feedback.setText(this.sendError || (hasProvider ? status?.message : this.bridgeError || routeError)
      || (!this.executor && this.providerDiscoveryComplete ? this.plugin.providerLoadError || PROVIDER_GUIDANCE : ""));
    this.input.placeholder = label ? `给 ${label} 下指令…` : "输入协作指令…";
    const snapshot = this.context?.snapshot;
    this.selectionLabel.setText(snapshot
      ? `${path.basename(snapshot.canvasPath)} · ${snapshot.effectiveNodeIds.length} 节点（分组展开 ${snapshot.expandedFromGroupIds.length}） · ${snapshot.internalEdges.length + snapshot.incomingEdges.length + snapshot.outgoingEdges.length} 连线`
      : "Canvas 未选取");
    this.selectionLabel.title = snapshot?.canvasPath || "";
    this.repoRow.hidden = !snapshot || !this.capabilities().supportsRepo;
    this.clear.hidden = !snapshot;
    this.syncModelSelectors();
    this.updateButton();
  }

  updateButton() {
    this.submit.disabled = this.sending || !this.isReady() || !this.input.value.trim();
    this.input.readOnly = this.sending;
    this.repo.readOnly = this.sending;
    if (this.modelSelect) this.modelSelect.disabled = this.sending || !this.modelSelect.options?.length;
    if (this.effortSelect) this.effortSelect.disabled = this.sending || !this.effortSelect.options?.length;
    if (this.autoToggle) {
      this.autoToggle.disabled = this.sending;
      this.autoToggle.setAttribute("aria-pressed", String(this.autoCapture));
    }
    this.capture.disabled = this.sending;
    this.clear.disabled = this.sending;
    for (const [value, button] of this.executorButtons) {
      button.disabled = this.sending;
      button.setAttribute("aria-pressed", String(value === this.executor));
    }
    for (const [value, button] of this.modeButtons) {
      button.disabled = this.sending || !this.context;
      button.setAttribute("aria-pressed", String(value === this.mode));
    }
    this.submitText.setText(this.sending ? "发送中…" : "发送指令");
  }

  startWatching() {
    if (this.watcher || !this.active) return;
    try {
      this.watcher = fs.watch(this.registration.bus, { recursive: true, persistent: false }, (_, name) => {
        const file = name && String(name).replace(/\\/g, "/");
        if (file && !/^(workspace_routes\.json|to_codex_req_[^/]+\.json|(?:requests|deliveries)\/req_[^/]+\.json|obsidian_codex_jobs(?:\/job_[^/]+\.json)?)$/.test(file)) return;
        this.scheduleRefresh();
      });
      this.watcher.on("error", () => this.watchFallback());
    } catch {
      this.watchFallback();
    }
  }

  watchFallback() {
    this.watcher?.close();
    this.watcher = null;
    window.clearTimeout(this.jobPoll);
    if (!this.fallback && this.active) this.fallback = window.setInterval(() => this.refresh(), 5000);
  }

  scheduleRefresh() {
    if (!this.active) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.refresh(), 160);
  }

  clearRenderComponent() {
    const component = this.renderComponent;
    this.renderComponent = null;
    if (!component) return;
    if (typeof this.removeChild === "function") this.removeChild(component);
    else component.unload?.();
  }

  showTasks(tasks) {
    this.tasks = tasks;
    const signature = JSON.stringify([tasks, this.plugin.appliedPatches]);
    if (signature === this.signature) return;
    this.signature = signature;
    const expanded = new Set(Array.from(this.list.querySelectorAll("details.bc-task[open]"), el => el.dataset.taskKey));
    const scroll = this.list.scrollTop;
    const newest = tasks.length ? taskKey(tasks[0]) : undefined;
    const arrived = newest && newest !== this.latest;
    if (arrived) expanded.delete(this.latest);
    this.clearRenderComponent();
    if (typeof Component === "function") {
      const component = new Component();
      this.renderComponent = this.addChild?.(component) ?? component;
    }
    this.list.empty();
    this.count.setText(String(tasks.length));
    if (!tasks.length) this.list.createDiv({ cls: "bc-empty", text: "还没有协作指令。" });
    for (const task of tasks) {
      const key = taskKey(task);
      addTask(this, task, expanded.has(key) || (arrived && key === newest));
    }
    this.list.scrollTop = arrived ? 0 : scroll;
    this.latest = newest;
  }

  addPatchActions(reply, task, context) {
    const patch = context.patch === undefined ? this.plugin.canvasContext?.extractCanvasPatch(task.reply) : context.patch;
    if (!patch) return;
    const actions = reply.createDiv({ cls: "bc-patch" });
    if (isPatchError(patch)) {
      actions.createSpan({ cls: "bc-task-error", text: patch.error });
      return;
    }
    actions.createSpan({ text: patchPreview(patch) });
    if (!context.canvasPath || !Array.isArray(context.selectedIds) || !context.selectedIds.length) {
      actions.createSpan({ cls: "bc-task-error", text: "这条指令没有锁定 Canvas 选区。" });
      return;
    }
    const key = taskKey(task);
    const applied = Object.hasOwn(this.plugin.appliedPatches, key);
    const appliedRecord = applied ? this.plugin.appliedPatches[key] : null;
    const canRevert = Boolean(appliedRecord && typeof appliedRecord === "object" && appliedRecord.undo);
    const controls = actions.createDiv({ cls: "bc-patch-buttons" });
    if (applied) {
      if (canRevert) {
        const revert = controls.createEl("button", { text: "撤销应用", attr: { type: "button" } });
        revert.onclick = async () => {
          revert.disabled = true;
          try {
            const summary = await this.plugin.revertReplyPatch(key);
            if (summary) new Notice(`已撤销 Canvas 补丁 · ${revertCounts(summary)}`);
            if (this.active) this.showTasks(this.tasks);
          } catch (error) {
            revert.disabled = false;
            new Notice(`撤销 Canvas 补丁失败 · ${error.message}`);
          }
        };
      } else {
        const done = controls.createEl("button", { text: "已应用", attr: { type: "button" } });
        done.disabled = true;
      }
      return;
    }
    const button = controls.createEl("button", { text: "应用到画布", attr: { type: "button" } });
    button.onclick = async () => {
      button.disabled = true;
      try {
        const summary = await this.plugin.applyReplyPatch(key, context, patch);
        if (summary) new Notice(`Canvas 补丁已应用 · ${patchCounts(summary)}`);
        if (this.active) this.showTasks(this.tasks);
      } catch (error) {
        button.disabled = false;
        new Notice(`Canvas 补丁应用失败 · ${error.message}`);
      }
    };
  }

  updateHistory() {
    if (!this.active) return;
    const tasks = [...(this.route?.tasks || []), ...(this.providerTasks || [])];
    const timestamp = task => new Date(task.time).getTime() || 0;
    this.showTasks(tasks.sort((a, b) => timestamp(b) - timestamp(a)).slice(0, 30));
    this.updateComposer();
  }

  syncSubscriptions(adapters) {
    for (const [adapter, stop] of this.providerSubscriptions) {
      if (adapters.includes(adapter)) continue;
      this.providerSubscriptions.delete(adapter);
      try { stop(); } catch (error) { console.error(error); }
    }
    for (const adapter of adapters) {
      if (!adapter.subscribe || this.providerSubscriptions.has(adapter)) continue;
      try {
        const stop = adapter.subscribe(this.workspacePath, () => void this.refreshProviders());
        if (typeof stop === "function") this.providerSubscriptions.set(adapter, stop);
      } catch (error) { console.error(error); }
    }
  }

  async refreshProviders() {
    const version = ++this.providerRefreshVersion;
    await this.plugin.settingsReady;
    if (!this.active || version !== this.providerRefreshVersion) return;
    const adapters = (this.plugin.providers?.list() || []).filter(adapter => !Object.hasOwn(EXECUTORS, adapter.id));
    this.syncSubscriptions(adapters.filter(adapter => adapter.enabled !== false));
    const results = await Promise.all(adapters.map(async adapter => {
      const [status, tasks] = await Promise.allSettled([
        Promise.resolve().then(() => adapter.enabled === false ? {} : adapter.getStatus(this.workspacePath)),
        Promise.resolve().then(() => adapter.listTasks(this.workspacePath)),
      ]);
      const reported = status.status === "fulfilled" ? status.value : undefined;
      const value = {
        ...reported,
        ready: Boolean((reported?.ready ?? reported?.available) && reported?.available !== false),
        models: Array.isArray(reported?.models) ? reported.models : [],
        message: reported?.message || reported?.error || (status.status === "rejected" ? String(status.reason?.message || status.reason) : ""),
      };
      return { adapter, value, tasks: tasks.status === "fulfilled" && Array.isArray(tasks.value) ? tasks.value : [] };
    }));
    if (!this.active || version !== this.providerRefreshVersion) return;
    const current = results.filter(({ adapter }) => this.plugin.providers.get(adapter.id) === adapter);
    this.providerStates = new Map(current.map(({ adapter, value }) => [adapter.id, { adapter, value }]));
    this.providerTasks = current.flatMap(({ adapter, tasks }) => tasks.filter(task => task?.id != null).map(task => ({
      ...task, executor: adapter.id, providerLabel: task.providerLabel || adapter.label,
    })));
    this.providerDiscoveryComplete = true;
    try { this.updateHistory(); } catch (error) { this.showRefreshError(error); }
  }

  stopWatching() {
    this.watcher?.close();
    this.watcher = null;
    window.clearInterval(this.fallback);
    this.fallback = null;
    window.clearTimeout(this.jobPoll);
  }

  async refreshBridge() {
    const registration = this.plugin.bridgeConnection;
    if (!registration) {
      this.stopWatching();
      this.registration = null;
      this.route = null;
      this.bridgeError = "";
      this.updateHistory();
      return;
    }
    if (registration !== this.registration) this.stopWatching();
    this.registration = registration;
    if (!this.fallback) this.startWatching();
    try {
      const state = await this.plugin.bridgeSnapshot(this.workspacePath);
      if (!this.active || registration !== this.plugin.bridgeConnection) return;
      this.route = state;
      this.bridgeError = "";
    } catch (error) {
      if (!this.active || registration !== this.plugin.bridgeConnection) return;
      this.route = null;
      this.bridgeError = error.message;
    } finally {
      if (this.active && registration === this.plugin.bridgeConnection) {
        this.updateHistory();
        window.clearTimeout(this.jobPoll);
        if (!this.fallback && this.route?.tasks?.some(task => task.executor === "codex" && task.status === "running")) {
          this.jobPoll = window.setTimeout(() => this.refresh(), 5000);
        }
      }
    }
  }

  refresh() {
    if (!this.active) return;
    if (this.refreshPromise) {
      this.refreshAgain = true;
      return this.refreshPromise;
    }
    this.refreshPromise = (async () => {
      await this.plugin.settingsReady;
      do {
        this.refreshAgain = false;
        if (!this.active) return;
        await Promise.all([this.refreshBridge(), this.refreshProviders()]);
      } while (this.active && this.refreshAgain);
    })().catch(error => this.showRefreshError(error)).finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  showRefreshError(error) {
    if (!this.active) return;
    this.sendError = error?.message || String(error);
    this.feedback.setText(this.sendError);
  }

  dispatchPayload(instruction) {
    const selected = this.context;
    const { supportsRepo, modes } = this.capabilities();
    const targetWorkspace = selected && supportsRepo ? this.repo.value.trim() || this.workspacePath : this.workspacePath;
    const executor = this.executor;
    const mode = !selected && modes?.includes("execute_task") ? "execute_task" : this.mode;
    const text = selected ? this.plugin.canvasContext.buildCanvasPromptEnvelope({
      userInstruction: instruction, executor, mode,
      canvasSnapshot: supportsRepo ? selected.snapshot : { ...selected.snapshot, detectedRepo: "" },
      fileExcerpts: selected.fileExcerpts, targetRepo: supportsRepo ? targetWorkspace : "",
    }) : instruction;
    const canvasPath = selected?.snapshot.canvasPath || "";
    const selectedIds = selected?.snapshot.effectiveNodeIds || [];
    if (!this.isBridgeExecutor()) {
      const label = this.plugin.providerLabel(executor).replace(/[\r\n]+/g, " ");
      return {
        workspace: this.workspacePath, targetWorkspace, executor, mode,
        // The shared envelope uses the legacy AGY label for non-Codex executors.
        prompt: selected ? text.replace(/\n执行者 AGY · 模式 /, () => `\n执行者 ${label} · 模式 `) : text,
        canvasPath, selectedIds, source: "Obsidian", model: this.selectedProviderModel(),
        ...(this.capabilities().supportsEffort && this.effortSelect?.value ? { effort: this.effortSelect.value } : {}),
      };
    }
    if (executor === "agy") {
      const model = this.selectedAgyModel();
      return {
        action: "send", project: this.route.project, conversation: this.route.conversation, text,
        ...(model ? { model } : {}),
      };
    }
    const model = this.selectedCodexModel();
    const effort = this.selectedCodexEffort();
    return {
      action: "dispatch_codex", text, mode, target_workspace: targetWorkspace,
      ...(model ? { model } : {}), ...(effort ? { effort } : {}),
      step_goal: selected ? `Obsidian Canvas：${MODES[mode]}` : "处理 Obsidian 指令",
      canvas_path: canvasPath, selected_ids: selectedIds,
    };
  }

  async send() {
    const text = this.input.value.trim();
    if (!text || !this.isReady() || this.sending) return;
    const refresh = this.isBridgeExecutor() ? () => this.refresh() : () => this.refreshProviders();
    this.sending = true;
    this.sendError = "";
    this.updateComposer();
    try {
      const payload = this.dispatchPayload(text);
      const intent = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      const token = this.draft.intent && this.draft.intent !== intent ? randomUUID() : this.draft.token;
      this.draft = { ...this.draft, token, intent };
      this.app.saveLocalStorage(DRAFT, this.draft);
      const provider = this.activeProvider();
      const result = provider
        ? await provider.dispatch({ ...payload, workspace: this.workspacePath, token })
        : await this.plugin.callBridge(this.workspacePath, { ...payload, token });
      if (result?.ok === false) throw new Error(result.error || "执行者未接受指令。");
      if (result?.settled) {
        void Promise.resolve(result.settled).then(
          refresh,
          error => { if (this.active) { this.sendError = error?.message || String(error); this.updateComposer(); } },
        );
      }
      if (this.app.loadLocalStorage(DRAFT)?.token === token) this.app.saveLocalStorage(DRAFT, null);
      this.draft = { token: randomUUID(), text: "" };
      if (this.active) this.input.value = "";
    } catch (error) {
      this.sendError = error.message;
    } finally {
      this.sending = false;
      if (this.active) {
        this.updateComposer();
        await refresh();
      }
    }
  }

  async onClose() {
    this.active = false;
    this.providerRefreshVersion++;
    this.plugin.openViews.delete(this);
    this.syncSubscriptions([]);
    this.clearRenderComponent();
    this.captureVersion++;
    this.stopWatching();
    window.clearTimeout(this.timer);
    window.clearTimeout(this.autoTimer);
  }
}

const CanvasBridgeSettingTab = typeof PluginSettingTab === "function" && typeof Setting === "function"
  ? class extends PluginSettingTab {
    constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

    display() {
      const { containerEl, plugin } = this;
      containerEl.empty();
      if (!plugin.settings) {
        containerEl.createDiv({ text: "无法加载 Canvas Bridge 服务配置。" });
        return;
      }
      new Setting(containerEl).setName("OpenAI 兼容服务").setHeading()
        .addButton(button => button.setButtonText("添加服务").onClick(async () => {
          const defaults = plugin.providerModule.DEFAULT_SETTINGS.openaiProviders[0];
          const profile = { ...defaults, name: "OpenAI 兼容服务", id: `openai-${randomUUID()}` };
          await this.save({ ...plugin.settings, openaiProviders: [...plugin.settings.openaiProviders, profile] });
          this.display();
        }));
      for (const profile of plugin.settings.openaiProviders) this.addProfile(profile);

      new Setting(containerEl).setName("Codex-Antigravity-Bridge（可选）").setHeading();
      const bridge = new Setting(containerEl).setName("启用本机桥接");
      this.bridgeStatus = bridge;
      this.updateBridgeStatus();
      bridge.addToggle(toggle => toggle.setValue(plugin.settings.enableBridge).onChange(async enableBridge => {
        await this.save({ ...plugin.settings, enableBridge });
        this.updateBridgeStatus();
      }));
    }

    updateBridgeStatus() {
      const { plugin } = this;
      this.bridgeStatus?.setDesc(!plugin.settings?.enableBridge ? "已停用"
        : plugin.bridgeProbe ? "正在检测本机桥接…" : plugin.bridgeConnection ? "已检测到本机桥接" : "未检测到本机桥接");
    }

    async save(settings) {
      try { await this.plugin.updateSettings(settings); }
      catch (error) { new Notice(`保存 Canvas Bridge 设置失败 · ${error.message}`); }
    }

    addProfile(profile) {
      const { containerEl, plugin } = this;
      const card = containerEl.createDiv({ cls: "bc-settings-card" });
      const change = patch => this.save({
        ...plugin.settings,
        openaiProviders: plugin.settings.openaiProviders.map(item => item.id === profile.id ? { ...item, ...patch } : item),
      });
      new Setting(card).setName("启用服务")
        .addToggle(toggle => toggle.setValue(profile.enabled).onChange(enabled => change({ enabled })));
      new Setting(card).setName("名称")
        .addText(text => text.setValue(profile.name).onChange(name => change({ name })));
      new Setting(card).setName("Base URL")
        .setDesc("例如 https://api.openai.com/v1，或本机服务的兼容 API 地址。")
        .addText(text => text.setValue(profile.baseUrl).onChange(baseUrl => change({ baseUrl })));
      new Setting(card).setName("API Key").setDesc("本机服务无需密钥时可留空。")
        .addText(text => {
          text.inputEl.type = "password";
          text.inputEl.autocomplete = "off";
          text.setValue(profile.apiKey).onChange(apiKey => change({ apiKey }));
        });
      new Setting(card).setName("模型").setDesc("用逗号或换行分隔。")
        .addTextArea(text => text.setValue(profile.models.join("\n")).onChange(models => change({ models })));
      new Setting(card).setName("系统提示词（可选）")
        .addTextArea(text => text.setValue(profile.systemPrompt).onChange(systemPrompt => change({ systemPrompt })));
      const actions = card.createDiv({ cls: "bc-settings-actions" });
      actions.createEl("button", { text: "测试连接", attr: { type: "button" } }).onclick = async event => {
        const latest = plugin.settings.openaiProviders.find(item => item.id === profile.id);
        if (!latest) return;
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await plugin.createHttpProvider(latest).testConnection();
          new Notice(`${latest.name} 连接成功`);
        } catch (error) {
          new Notice(`${latest.name} 连接失败 · ${error.message}`);
        } finally {
          button.disabled = false;
        }
      };
      actions.createEl("button", { cls: "mod-warning", text: "移除服务", attr: { type: "button" } }).onclick = async () => {
        await this.save({ ...plugin.settings, openaiProviders: plugin.settings.openaiProviders.filter(item => item.id !== profile.id) });
        this.display();
      };
    }
  } : null;

module.exports = class BridgeChatPlugin extends Plugin {
  onload() {
    this.appliedPatches = this.app.loadLocalStorage(APPLIED) || {};
    this.applyingCanvases = new Set();
    this.openViews = new Set();
    this.httpProviders = new Map();
    this.bridgeProviders = new Map();
    this.canvasLoadError = "";
    this.ensureCanvasContext();
    this.settingsReady = this.initializeProviders();
    if (CanvasBridgeSettingTab && this.addSettingTab) {
      this.settingsTab = new CanvasBridgeSettingTab(this.app, this);
      this.addSettingTab(this.settingsTab);
    }
    this.lastCanvasLeaf = this.app.workspace.getMostRecentLeaf();
    this.registerView(VIEW, leaf => new BridgeView(leaf, this));
    this.addRibbonIcon("messages-square", "打开协作对话", () => this.openPanel());
    this.addCommand({ id: "open", name: "打开协作对话", callback: () => this.openPanel() });
    this.addCommand({
      id: "capture-canvas-selection", name: "抓取当前 Canvas 选区到协作对话",
      callback: () => this.captureInPanel(),
    });
    this.addCommand({
      id: "send-canvas-to-codex", name: "用 Codex 处理当前 Canvas 选区",
      callback: () => this.captureInPanel({ executor: "codex" }),
    });
    this.addCommand({
      id: "send-canvas-to-agy", name: "用 AGY 处理当前 Canvas 选区",
      callback: () => this.captureInPanel({ executor: "agy" }),
    });
    this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => {
      if (leaf?.view?.getViewType() === "canvas") this.lastCanvasLeaf = leaf;
    }));
    this.registerCanvasMenu("canvas:node-menu", node => ({ canvas: node?.canvas, ids: selectionIds([node]) }));
    this.registerCanvasMenu("canvas:selection-menu", canvas => ({ canvas, ids: selectionIds(canvas?.selection) }));
    return this.settingsReady;
  }

  pluginDir() {
    const dir = this.manifest?.dir;
    if (!dir) return null;
    if (path.isAbsolute(dir)) return dir;
    const basePath = this.app?.vault?.adapter?.getBasePath?.();
    return basePath ? path.join(basePath, dir) : null;
  }

  async initializeProviders() {
    const dir = this.pluginDir();
    if (!dir) return;
    try {
      this.providerModule = loadLocalModule(dir, "providers.js", LOCAL_BUILTINS);
      const { ProviderRegistry, LocalTaskStore, normalizeSettings } = this.providerModule;
      this.providers = new ProviderRegistry();
      this.localTaskStore = new LocalTaskStore({
        load: () => this.app.loadLocalStorage?.(PROVIDER_TASKS),
        save: tasks => this.app.saveLocalStorage?.(PROVIDER_TASKS, tasks),
      });
      this.settings = normalizeSettings();
      if (typeof this.loadData === "function") {
        try { this.settings = normalizeSettings(await this.loadData()); }
        catch (error) { new Notice(`读取 Canvas Bridge 设置失败 · ${error.message}`); }
      }
      this.syncHttpProviders();
      this.settingsLoaded = true;
      await this.probeBridge();
    } catch (error) {
      this.providerLoadError = error.message || String(error);
      if (typeof Notice === "function") new Notice(`无法加载 Canvas Bridge 服务 · ${this.providerLoadError}`);
    }
  }

  registerProvider(adapter) {
    if (Object.hasOwn(EXECUTORS, adapter?.id) || this.httpProviders.has(adapter?.id)) {
      throw new Error(`执行者 ID 已由 Canvas Bridge 使用：${adapter.id}`);
    }
    const registered = this.providers.register(adapter);
    this.refreshProviderViews();
    return registered;
  }

  unregisterProvider(id) {
    const removed = this.providers?.unregister(id) || false;
    if (removed) this.refreshProviderViews();
    return removed;
  }

  getProviders() { return this.providers?.list() || []; }

  providerLabel(id) { return this.providers?.get(id)?.label || (Object.hasOwn(EXECUTORS, id) ? EXECUTORS[id] : id); }

  async updateSettings(nextSettings) {
    if (!this.settingsLoaded) await this.settingsReady;
    if (!this.settings) throw new Error("无法加载 Canvas Bridge 服务配置。");
    const previousEnableBridge = this.settings.enableBridge;
    const settings = this.providerModule.normalizeSettings({ ...this.settings, ...nextSettings });
    this.settings = settings;
    this.syncHttpProviders();
    const saved = (this.settingsSave || Promise.resolve()).catch(() => {}).then(() => this.saveData?.(settings));
    this.settingsSave = saved;
    const probe = previousEnableBridge !== settings.enableBridge ? this.probeBridge() : undefined;
    this.refreshProviderViews();
    await Promise.all([saved, probe]);
    return settings;
  }

  createHttpProvider(config) {
    return this.providerModule.createOpenAICompatibleProvider(config, {
      store: this.localTaskStore,
      requestFn: requestHttp,
      notify: () => this.refreshProviderViews(),
    });
  }

  syncHttpProviders() {
    for (const [id, adapter] of this.httpProviders) {
      if (this.providers.get(id) === adapter) this.providers.unregister(id);
    }
    this.httpProviders.clear();
    for (const config of this.settings.openaiProviders) {
      if (Object.hasOwn(EXECUTORS, config.id) || this.providers.get(config.id)) continue;
      const adapter = this.providers.register(this.createHttpProvider(config));
      this.httpProviders.set(adapter.id, adapter);
    }
  }

  refreshProviderViews() {
    for (const view of this.openViews) void view.refreshProviders();
  }

  probeBridge() {
    if (!this.settings?.enableBridge) {
      this.setBridgeConnection(null);
      return;
    }
    if (!this.bridgeProbe) {
      this.bridgeProbe = bridgeRegistration().catch(() => null).then(connection => {
        if (this.settings.enableBridge) this.setBridgeConnection(connection);
      }).finally(() => {
        this.bridgeProbe = null;
        this.settingsTab?.updateBridgeStatus();
      });
    }
    return this.bridgeProbe;
  }

  setBridgeConnection(connection) {
    if (this.bridgeConnection?.server === connection?.server && this.bridgeConnection?.python === connection?.python) return;
    this.bridgeConnection = connection;
    this.bridgeSnapshots = new Map();
    for (const [id, adapter] of this.bridgeProviders) {
      if (this.providers.get(id) === adapter) this.providers.unregister(id);
    }
    this.bridgeProviders.clear();
    if (connection) {
      for (const [id, label] of Object.entries(EXECUTORS)) {
        const adapter = this.providers.register({
          id, label, kind: "bridge", capabilities: { ...BRIDGE_CAPABILITIES, supportsEffort: id === "codex" },
          getStatus: workspace => {
            const state = this.bridgeSnapshots.get(workspace);
            return { ready: Boolean(id === "codex" ? state?.codex_ready : state?.paired) };
          },
          listTasks: workspace => (this.bridgeSnapshots.get(workspace)?.tasks || []).filter(task => (task.executor || "agy") === id),
          dispatch: ({ workspace, ...payload }) => this.callBridge(workspace, payload),
        });
        this.bridgeProviders.set(id, adapter);
      }
    }
    for (const view of this.openViews) void view.refresh();
  }

  callBridge(workspace, payload) {
    if (!this.bridgeConnection) throw new Error(PROVIDER_GUIDANCE);
    return callBridge(this.bridgeConnection, path.join(this.pluginDir(), "bridge_client.py"), workspace, payload);
  }

  async bridgeSnapshot(workspace) {
    const connection = this.bridgeConnection;
    const state = await this.callBridge(workspace, { action: "snapshot" });
    if (connection === this.bridgeConnection) this.bridgeSnapshots.set(workspace, state);
    return state;
  }

  registerCanvasMenu(event, context) {
    this.registerEvent(this.app.workspace.on(event, (menu, ...args) => {
      menu?.addItem?.(item => item.setTitle("抓取选区到协作对话").setIcon("scan")
        .onClick(() => this.captureInPanel({ hint: context(...args) })));
    }));
  }

  async captureInPanel({ executor, hint } = {}) {
    try {
      const view = await this.openPanel();
      if (!view || view.sending || !await view.captureSelection(hint)) return;
      if (executor) {
        if (view.setExecutor(executor) === false) { new Notice(PROVIDER_GUIDANCE); return; }
        if (view.input.value.trim()) await view.send();
      }
      view.input.focus();
    } catch (error) {
      new Notice(error.message);
    }
  }

  ensureCanvasContext() {
    if (this.canvasContext) return this.canvasContext;
    const dir = this.pluginDir();
    if (!dir) return null;
    try {
      const context = loadLocalModule(dir, "canvas_context.js", LOCAL_BUILTINS);
      if (typeof context?.extractSelectionSnapshot !== "function" || typeof context.applyCanvasPatch !== "function") {
        throw new Error("canvas_context.js 导出接口不完整。");
      }
      this.canvasContext = context;
      this.canvasLoadError = "";
      return this.canvasContext;
    } catch (error) {
      this.canvasLoadError = error.message || String(error);
      return null;
    }
  }

  orderedCanvasLeaves(hint) {
    const leaves = this.app.workspace.getLeavesOfType("canvas");
    const preferred = hint?.canvas && leaves.find(leaf => leaf.view.canvas === hint.canvas);
    const last = leaves.includes(this.lastCanvasLeaf) && this.lastCanvasLeaf.view.getViewType() === "canvas"
      ? this.lastCanvasLeaf : null;
    return { preferred, last, leaves: [...new Set([preferred, last, ...leaves].filter(Boolean))] };
  }

  focusCanvasNode(canvasPath, nodeId) {
    if (!canvasPath || !nodeId) return;
    for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
      if (canvasPathOf(leaf) !== canvasPath) continue;
      const canvas = leaf.view.canvas;
      const liveNode = canvas?.nodes?.get?.(nodeId);
      if (!liveNode) continue;
      canvas.selectOnly?.(liveNode);
      canvas.zoomToSelection?.();
      return;
    }
  }

  peekCanvasSelection(hint) {
    const { preferred, last, leaves } = this.orderedCanvasLeaves(hint);
    for (const leaf of leaves) {
      if (leaf.view.getViewType() !== "canvas") continue;
      const ids = (leaf === (preferred || last) && hint?.ids?.length)
        ? hint.ids : selectionIds(leaf.view.canvas?.selection);
      const canvasPath = canvasPathOf(leaf);
      if (ids.length && canvasPath) {
        return { leaf, canvasPath, ids, signature: selectionSignature(canvasPath, ids) };
      }
    }
    return null;
  }

  async getCanvasSelection(hint) {
    if (!this.ensureCanvasContext()) {
      throw new Error(this.canvasLoadError ? `Canvas 协作模块加载失败：${this.canvasLoadError}` : "Canvas 协作模块尚未加载。");
    }
    const { preferred, last, leaves } = this.orderedCanvasLeaves(hint);
    let readError;
    for (const leaf of leaves) {
      if (leaf.view.getViewType() !== "canvas") continue;
      const ids = (leaf === (preferred || last) && hint?.ids?.length)
        ? hint.ids : selectionIds(leaf.view.canvas?.selection);
      const canvasPath = canvasPathOf(leaf);
      if (!ids.length || !canvasPath) continue;
      let data;
      try {
        data = readCanvasView(leaf.view);
      } catch (error) {
        readError ??= error;
        continue;
      }
      const snapshot = this.canvasContext.extractSelectionSnapshot(data, ids, canvasPath);
      if (!snapshot.effectiveNodeIds.length) continue;
      const fileExcerpts = await this.readFileExcerpts(snapshot.nodes, leaf.view.canvas);
      return { snapshot: this.canvasContext.extractSelectionSnapshot(data, ids, canvasPath, { fileExcerpts }), fileExcerpts };
    }
    throw readError || new Error("请先在 Canvas 中选中节点。");
  }

  async readFileExcerpts(nodes, canvas) {
    const paths = new Set(nodes.filter(node => node.type === "file" && typeof node.file === "string").map(node => node.file));
    const vault = this.app.vault;
    const entries = await Promise.all([...paths].map(async file => {
      try {
        const tfile = canvas?.resolveFilePath?.(file) || vault.getFileByPath(file);
        if (tfile?.extension?.toLowerCase() !== "md") return [file, ""];
        return [file, (await vault.cachedRead(tfile)).slice(0, 4000)];
      } catch (error) {
        new Notice(`无法读取 Canvas 文件摘录 · ${file} · ${error.message}`);
        return [file, ""];
      }
    }));
    return Object.fromEntries(entries);
  }

  async applyReplyPatch(key, { canvasPath, selectedIds }, patch) {
    if (Object.hasOwn(this.appliedPatches, key)) return null;
    const file = this.app.vault.getFileByPath(canvasPath);
    if (!file || file.extension !== "canvas") throw new Error(`找不到目标画布 ${canvasPath}。`);
    if (this.applyingCanvases.has(file.path)) throw new Error("此画布正在应用另一条补丁，请稍后重试。");
    this.applyingCanvases.add(file.path);
    try {
      let summary;
      let undo;
      await this.mutateCanvasFile(file, original => {
        const data = validateCanvasData(original);
        const selected = data.nodes?.filter(node => selectedIds.includes(node.id)) || [];
        const { selectionBounds } = this.canvasContext.extractSelectionSnapshot({ nodes: selected }, selectedIds, file.path);
        const result = this.canvasContext.applyCanvasPatch(data, patch, {
          allowedNodeIds: selectedIds, selectionBounds, allowMove: true,
        });
        summary = result.summary;
        undo = result.undo;
        return { ...data, ...result.data };
      });
      this.appliedPatches[key] = { canvasPath: file.path, undo, appliedAt: new Date().toISOString() };
      this.app.saveLocalStorage(APPLIED, this.appliedPatches);
      return summary;
    } finally {
      this.applyingCanvases.delete(file.path);
    }
  }

  async revertReplyPatch(key) {
    if (!this.ensureCanvasContext()) {
      throw new Error(this.canvasLoadError ? `Canvas 协作模块加载失败：${this.canvasLoadError}` : "Canvas 协作模块尚未加载。");
    }
    const record = this.appliedPatches[key];
    if (!record || typeof record !== "object" || !record.undo || !record.canvasPath) {
      throw new Error("这条旧记录没有可撤销的快照。");
    }
    const file = this.app.vault.getFileByPath(record.canvasPath);
    if (!file || file.extension !== "canvas") throw new Error(`找不到目标画布 ${record.canvasPath}。`);
    if (this.applyingCanvases.has(file.path)) throw new Error("此画布正在执行补丁操作，请稍后重试。");
    this.applyingCanvases.add(file.path);
    try {
      let summary;
      await this.mutateCanvasFile(file, original => {
        const data = validateCanvasData(original);
        const result = this.canvasContext.revertCanvasPatch(data, record.undo);
        summary = result.summary;
        return { ...data, ...result.data };
      });
      delete this.appliedPatches[key];
      this.app.saveLocalStorage(APPLIED, this.appliedPatches);
      return summary;
    } finally {
      this.applyingCanvases.delete(file.path);
    }
  }

  async mutateCanvasFile(file, transform) {
    const matching = this.app.workspace.getLeavesOfType("canvas").filter(leaf => canvasPathOf(leaf) === file.path);
    const open = matching.includes(this.lastCanvasLeaf) ? this.lastCanvasLeaf : matching[0];
    if (open) {
      await this.writeOpenCanvas(open, transform);
    } else {
      await this.app.vault.process(file, text => JSON.stringify(transform(JSON.parse(text)), null, "\t"));
    }
  }

  async writeOpenCanvas(open, transform) {
    const canvas = open.view.canvas;
    if (typeof canvas?.getData !== "function"
        || (typeof canvas.importData !== "function" && typeof canvas.setData !== "function")
        || typeof canvas.requestSave !== "function") {
      throw new Error("打开的 Canvas 暂时无法保存，请重新打开画布后重试。");
    }
    const beforeData = cloneJson(validateCanvasData(canvas.getData()));
    const nextData = transform(beforeData);
    canvas.deselectAll?.();
    if (typeof canvas.pushHistory === "function") {
      canvas.pushHistory(beforeData);
    }
    if (typeof canvas.importData === "function") {
      await canvas.importData(nextData, true);
    } else {
      await canvas.setData(nextData);
    }
    if (typeof canvas.pushHistory === "function") {
      if (!canvas.history?.data?.length) canvas.pushHistory(beforeData);
      canvas.pushHistory(nextData);
    }
    await canvas.requestSave();
  }

  async openPanel() {
    const workspace = this.app.workspace;
    let leaf = workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW, active: true });
    }
    await workspace.revealLeaf(leaf);
    leaf.view.input?.focus();
    return leaf.view;
  }
};
