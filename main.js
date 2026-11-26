const { Component, ItemView, MarkdownRenderer, Notice, Plugin, Scope, setIcon } = require("obsidian");
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const { createHash, randomUUID } = crypto;
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CANVAS_BUILTINS = { "node:crypto": crypto, crypto, "node:path": path, path };

function loadCanvasContext(pluginDir) {
  const filename = path.join(pluginDir, "canvas_context.js");
  const source = fs.readFileSync(filename, "utf8");
  const mod = { exports: {} };
  const localRequire = id => (Object.hasOwn(CANVAS_BUILTINS, id) ? CANVAS_BUILTINS[id] : require(id));
  new Function("module", "exports", "require", "__filename", "__dirname", source)(
    mod, mod.exports, localRequire, filename, pluginDir,
  );
  if (typeof mod.exports?.extractSelectionSnapshot !== "function" || typeof mod.exports?.applyCanvasPatch !== "function") {
    throw new Error("canvas_context.js 导出接口不完整。");
  }
  return mod.exports;
}

const VIEW = "obsidian-canvas-bridge";
const DRAFT = `${VIEW}:draft`;
const APPLIED = `${VIEW}:applied`;
const AUTO_CAPTURE = `${VIEW}:auto-capture`;
const MODEL_PREFS = `${VIEW}:models`;
const EXECUTORS = { agy: "AGY", codex: "Codex" };
const MODES = { edit_canvas: "改选区画布", execute_task: "执行任务" };
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

function segmented(parent, label, options, onChange) {
  const group = parent.createDiv({ cls: "bc-segment", attr: { role: "group", "aria-label": label } });
  return Object.entries(options).map(([value, text]) => {
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
  return {
    agy: typeof raw.agy === "string" ? raw.agy : "",
    codex: typeof raw.codex === "string" ? raw.codex : "",
    codexEffort: typeof raw.codexEffort === "string" ? raw.codexEffort : "",
  };
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
  if (task.executor === "codex") return task;
  return task.source === "Obsidian" && typeof metadata?.canvasPath === "string" && metadata.executor === "agy"
    ? metadata : {};
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
  const executor = EXECUTORS[task.executor] || "AGY";
  const details = view.list.createEl("details", { cls: "bc-task" });
  details.dataset.request = task.id;
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
    heading.createSpan({ text: task.executor === "codex" ? "Codex" : "Antigravity" });
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
    this.loading = false;
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
    this.autoCapture = this.app.loadLocalStorage(AUTO_CAPTURE) !== false;
    this.lastAutoSignature = "";
    this.repoManual = false;
    this.modelPrefs = loadModelPrefs(this.app);
    this.modelOptionsKey = "";
    this.effortOptionsKey = "";
    this.workspacePath = this.app.vault.adapter.getBasePath();
    this.helper = path.join(this.workspacePath, this.plugin.manifest.dir, "bridge_client.py");
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
    const refresh = iconButton(header, "refresh-cw", "刷新配对和指令");
    refresh.onclick = () => this.refresh();
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
    this.updateComposer();
    this.scheduleAutoCapture(0);
    await this.refresh();
  }

  buildCanvasControls() {
    const controls = this.form.createDiv({ cls: "bc-compose-options" });
    this.executorButtons = segmented(controls, "执行者", EXECUTORS, value => this.setExecutor(value));
    this.modeButtons = segmented(controls, "Canvas 模式", MODES, value => {
      this.mode = value;
      this.updateComposer();
    });
    const modelBar = this.form.createDiv({ cls: "bc-model-bar" });
    const modelWrap = modelBar.createEl("label", { cls: "bc-model-wrap" });
    modelWrap.createSpan({ text: "模型" });
    this.modelSelect = modelWrap.createEl("select", { cls: "bc-model-select dropdown", attr: { "aria-label": "选择模型" } });
    this.modelSelect.onchange = () => this.onModelChange();
    this.effortWrap = modelBar.createEl("label", { cls: "bc-effort-wrap" });
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
    this.executor = executor;
    this.sendError = "";
    this.updateComposer();
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
    } else {
      const defaultHint = this.route?.agy_default_model ? `参考默认：${this.route.agy_default_model}` : "使用当前桌面对话默认模型";
      options = [
        { value: "", label: "跟随当前对话（默认）", title: defaultHint },
        ...this.agyModels().map(m => ({ value: m.id, label: m.label || m.id, title: m.id })),
      ];
      selected = this.selectedAgyModel();
    }
    const modelKey = JSON.stringify([this.executor, options]);
    if (modelKey !== this.modelOptionsKey) {
      this.modelOptionsKey = modelKey;
      fillSelect(this.modelSelect, options, selected);
    } else if (this.modelSelect.value !== selected) {
      this.modelSelect.value = selected;
    }
    if (!this.effortWrap || !this.effortSelect) return;
    this.effortWrap.hidden = !isCodex;
    if (!isCodex) return;
    const entry = this.codexModels().find(item => item.id === selected);
    const efforts = Array.isArray(entry?.efforts) && entry.efforts.length ? entry.efforts : [];
    const effortOptions = efforts.map(e => ({ value: e, label: e, title: `推理强度 ${e}` }));
    const selectedEffort = this.selectedCodexEffort();
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
    this.modelPrefs.codexEffort = this.effortSelect.value;
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
    return this.executor === "codex" ? this.route?.codex_ready : this.route?.paired;
  }

  updateComposer() {
    const state = this.route;
    const ready = Boolean(this.isReady());
    const isCodex = this.executor === "codex";
    const connection = isCodex ? (ready ? "Codex 就绪" : "Codex 未就绪") : (ready ? "AGY 已配对" : "AGY 待配对");
    this.indicator.setText(state ? connection : this.connectionError ? "连接中断" : "正在连接");
    this.indicator.dataset.ready = String(ready);
    const codexModel = this.selectedCodexModel() || state?.codex_model;
    const agyModel = this.selectedAgyModel();
    this.vaultLabel.title = isCodex
      ? [this.workspacePath, codexModel, this.selectedCodexEffort()].filter(Boolean).join("\n")
      : state?.paired
        ? `${this.workspacePath}\n项目 ${state.project}\n对话 ${state.conversation}${agyModel ? `\n指定模型 ${agyModel}` : ""}`
        : this.workspacePath;
    const routeError = state && !ready && (isCodex
      ? state.codex_error || "请先在 Codex 路由设置中配置有效的 worker_profile.model。"
      : state.reason || "请在 Codex 中为本仓库配对 Antigravity 桌面对话。");
    this.feedback.setText(this.sendError || this.connectionError || routeError || "");
    this.input.placeholder = `给 ${EXECUTORS[this.executor]} 下指令…`;
    const snapshot = this.context?.snapshot;
    this.selectionLabel.setText(snapshot
      ? `${path.basename(snapshot.canvasPath)} · ${snapshot.effectiveNodeIds.length} 节点（分组展开 ${snapshot.expandedFromGroupIds.length}） · ${snapshot.internalEdges.length + snapshot.incomingEdges.length + snapshot.outgoingEdges.length} 连线`
      : "Canvas 未选取");
    this.selectionLabel.title = snapshot?.canvasPath || "";
    this.repoRow.hidden = !snapshot;
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
    const signature = JSON.stringify([tasks, this.plugin.appliedPatches]);
    if (signature === this.signature) return;
    this.signature = signature;
    const expanded = new Set(Array.from(this.list.querySelectorAll("details.bc-task[open]"), el => el.dataset.request));
    const scroll = this.list.scrollTop;
    const newest = tasks[0]?.id;
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
    for (const task of tasks) addTask(this, task, expanded.has(task.id) || (arrived && task.id === newest));
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
    const key = `${task.executor || "agy"}:${task.id}`;
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
            if (this.active) this.showTasks(this.route?.tasks || []);
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
        if (this.active) this.showTasks(this.route?.tasks || []);
      } catch (error) {
        button.disabled = false;
        new Notice(`Canvas 补丁应用失败 · ${error.message}`);
      }
    };
  }

  async refresh() {
    if (!this.active) return;
    if (this.loading) { this.refreshAgain = true; return; }
    this.loading = true;
    try {
      this.registration ??= await bridgeRegistration();
      if (!this.active) return;
      if (!this.fallback) this.startWatching();
      const state = await callBridge(this.registration, this.helper, this.workspacePath, { action: "snapshot" });
      if (!this.active) return;
      this.route = state;
      this.connectionError = "";
      this.showTasks(state.tasks);
      this.hasRunningJob = state.tasks.some(task => task.executor === "codex" && task.status === "running");
    } catch (error) {
      if (!this.active) return;
      this.route = null;
      this.registration = null;
      this.connectionError = error.message;
    } finally {
      this.loading = false;
      if (this.active) {
        this.updateComposer();
        window.clearTimeout(this.jobPoll);
        if (!this.fallback && this.hasRunningJob) this.jobPoll = window.setTimeout(() => this.refresh(), 5000);
        if (this.refreshAgain) { this.refreshAgain = false; this.scheduleRefresh(); }
      }
    }
  }

  dispatchPayload(instruction) {
    const selected = this.context;
    const targetWorkspace = selected ? this.repo.value.trim() || this.workspacePath : this.workspacePath;
    const executor = this.executor;
    const mode = selected ? this.mode : "execute_task";
    const text = selected ? this.plugin.canvasContext.buildCanvasPromptEnvelope({
      userInstruction: instruction, executor, mode, canvasSnapshot: selected.snapshot,
      fileExcerpts: selected.fileExcerpts, targetRepo: targetWorkspace,
    }) : instruction;
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
      canvas_path: selected?.snapshot.canvasPath || "", selected_ids: selected?.snapshot.effectiveNodeIds || [],
    };
  }

  async send() {
    const text = this.input.value.trim();
    if (!text || !this.isReady() || this.sending) return;
    this.sending = true;
    this.sendError = "";
    this.updateComposer();
    try {
      const payload = this.dispatchPayload(text);
      const intent = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      const token = this.draft.intent && this.draft.intent !== intent ? randomUUID() : this.draft.token;
      this.draft = { ...this.draft, token, intent };
      this.app.saveLocalStorage(DRAFT, this.draft);
      await callBridge(this.registration, this.helper, this.workspacePath, { ...payload, token });
      if (this.app.loadLocalStorage(DRAFT)?.token === token) this.app.saveLocalStorage(DRAFT, null);
      this.draft = { token: randomUUID(), text: "" };
      if (this.active) this.input.value = "";
    } catch (error) {
      this.sendError = error.message;
    } finally {
      this.sending = false;
      if (this.active) {
        this.updateComposer();
        await this.refresh();
      }
    }
  }

  async onClose() {
    this.active = false;
    this.clearRenderComponent();
    this.captureVersion++;
    this.watcher?.close();
    this.watcher = null;
    window.clearTimeout(this.timer);
    window.clearTimeout(this.autoTimer);
    window.clearTimeout(this.jobPoll);
    window.clearInterval(this.fallback);
    this.fallback = null;
  }
}

module.exports = class BridgeChatPlugin extends Plugin {
  onload() {
    this.appliedPatches = this.app.loadLocalStorage(APPLIED) || {};
    this.applyingCanvases = new Set();
    this.canvasLoadError = "";
    this.ensureCanvasContext();
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
        view.setExecutor(executor);
        if (view.input.value.trim()) await view.send();
      }
      view.input.focus();
    } catch (error) {
      new Notice(error.message);
    }
  }

  ensureCanvasContext() {
    if (this.canvasContext) return this.canvasContext;
    const basePath = this.app?.vault?.adapter?.getBasePath?.();
    const dir = this.manifest?.dir;
    if (!basePath || !dir) return null;
    try {
      this.canvasContext = loadCanvasContext(path.join(basePath, dir));
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
