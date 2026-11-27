const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const canvasContext = require("../canvas_context.js");
const kanbanContext = require("../kanban_context.js");
const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

function testFrontMatterInfo(text) {
  const match = /^(---\r?\n)((?:[^\n]*\n)*?)---(?:\r?\n|$)/.exec(text);
  return match ? { exists: true, frontmatter: match[2], from: match[1].length, to: match[1].length + match[2].length, contentStart: match[0].length }
    : { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
}

function testParseYaml(text) {
  return Object.fromEntries(text.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const boundary = line.indexOf(": ");
    return [line.slice(0, boundary), JSON.parse(line.slice(boundary + 2))];
  }));
}

function testStringifyYaml(fm) {
  return Object.entries(fm).map(([name, value]) => `${name}: ${JSON.stringify(value)}\n`).join("");
}

class FakeElement {
  constructor(tag = "div", options = {}) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.attributes = {};
    this.style = { setProperty: (name, value) => { this.style[name] = value; } };
    const classes = new Set((options.cls || "").split(/\s+/).filter(Boolean));
    this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) };
    this.textContent = options.text || "";
    this.open = false;
    this.listeners = new Map();
    if (options.attr) for (const [name, value] of Object.entries(options.attr)) this.setAttribute(name, value);
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addClass(name) { this.classList.add(name); }
  setText(text) { this.textContent = String(text ?? ""); this.children = []; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  createEl(tag, options = {}) { return this.appendChild(new FakeElement(tag, options)); }
  createDiv(options = {}) { return this.createEl("div", options); }
  createSpan(options = {}) { return this.createEl("span", options); }
  empty() { for (const child of [...this.children]) child.remove(); this.textContent = ""; }
  remove() {
    const parent = this.parentElement;
    if (parent) parent.children = parent.children.filter(child => child !== this);
    this.parentElement = null;
  }
  contains(element) { return this === element || this.children.some(child => child.contains(element)); }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolled = true; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  removeEventListener(name) { this.listeners.delete(name); }
  matches(selector) {
    const [, tag, classes, open] = /^([\w-]*)([.\w-]*)(\[open\])?$/.exec(selector);
    return (!tag || this.tagName === tag.toUpperCase()) && (!open || this.open)
      && classes.split(".").filter(Boolean).every(name => this.classList.contains(name));
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  get options() { return this.children; }
  get innerText() { return [this.textContent, ...this.children.map(child => child.innerText)].filter(Boolean).join(""); }
}

function setup(options = {}) {
  const module = { exports: {} };
  const viewTypes = new Map();
  const events = new Map();
  const leaves = [];
  const commands = [];
  const commandCallbacks = new Map();
  const saved = new Map();
  const notices = [];
  const writes = [];
  const pluginDir = path.join(__dirname, "..");
  const app = {
    workspace: {
      getLeavesOfType: type => leaves.filter(leaf => leaf.view.getViewType() === type),
      getMostRecentLeaf: () => null,
      on: (name, handler) => events.set(name, handler),
    },
    vault: {},
    metadataCache: options.metadataCache,
    loadLocalStorage: key => saved.get(key),
    saveLocalStorage: (key, value) => saved.set(key, value),
  };
  class Plugin {
    constructor() {
      this.app = app;
      if (options.realModules) this.manifest = { dir: path.basename(pluginDir) };
    }
    registerView(type, create) { viewTypes.set(type, create); }
    addRibbonIcon() {}
    addCommand(command) { commands.push(command.id); commandCallbacks.set(command.id, command.callback); }
    registerEvent() {}
  }
  class ItemView {
    constructor() { this.app = app; this.children = []; this.contentEl = new FakeElement(); }
    addChild(child) { this.children.push(child); return child; }
    removeChild(child) { this.children = this.children.filter(item => item !== child); child.unload?.(); }
    registerDomEvent() {}
    registerEvent() {}
  }
  class Scope { register() {} }
  class Component { constructor() { this.unloaded = false; } unload() { this.unloaded = true; } }
  const obsidian = { Plugin, ItemView, Scope, setIcon() {},
    getFrontMatterInfo: testFrontMatterInfo, parseYaml: testParseYaml, stringifyYaml: testStringifyYaml };
  if (options.realModules) {
    app.vault.adapter = { getBasePath: () => path.dirname(pluginDir) };
    app.vault.getName = () => "Example Vault";
    obsidian.Notice = class { constructor(text) { notices.push(text); } };
    obsidian.requestUrl = options.requestUrl;
    Plugin.prototype.loadData = async () => options.settings;
    Plugin.prototype.saveData = async value => { writes.push(JSON.parse(JSON.stringify(value))); };
  }
  Object.assign(obsidian, options.obsidian);
  if (options.obsidian?.PluginSettingTab) {
    Plugin.prototype.addSettingTab = function (tab) { this.registeredSettingsTab = tab; };
  }
  if (options.render) {
    obsidian.Component = Component;
    obsidian.MarkdownRenderer = { render: options.render };
  }
  const files = [];
  const obsidianRequire = name => {
    if (name === "obsidian") return obsidian;
    if (!options.realModules) return require(name);
    if (name === "node:fs") return {
      readFileSync(filename, encoding) { files.push(path.basename(filename)); return fs.readFileSync(filename, encoding); },
      promises: { async readFile(filename) {
        assert.equal(path.basename(filename), "mcp_config.json");
        if (options.bridgeConfig) return JSON.stringify(options.bridgeConfig);
        throw Object.assign(new Error("missing MCP config"), { code: "ENOENT" });
      } },
      watch: options.watch,
    };
    if (name === "node:child_process" && options.execFile) return { execFile: options.execFile };
    if (["node:child_process", "node:crypto", "node:os", "node:path"].includes(name)) return require(name);
    throw new Error(`Obsidian require cannot resolve module: ${name}`);
  };
  vm.runInNewContext(main, {
    module,
    URL,
    fetch: options.fetch,
    window: { setTimeout, clearTimeout, setInterval, clearInterval, ...options.timers },
    require: obsidianRequire,
  });
  const plugin = new module.exports();
  if (!options.realModules) Object.assign(plugin, { canvasContext, kanbanContext });
  plugin.onload();
  return {
    plugin, app, events, leaves, commands, commandCallbacks, saved, notices, writes, files, obsidianRequire,
    createView: () => viewTypes.get("obsidian-canvas-bridge")({}),
  };
}

function leaf(file, canvas, fallback) {
  return { view: { getViewType: () => "canvas", file, canvas, getViewData: fallback } };
}

function card(id, fields = {}) {
  return { id, type: "text", x: 0, y: 0, width: 100, height: 50, ...fields };
}

async function openRerunView(t, options) {
  const env = setup({ realModules: true, ...options });
  env.saved.set("obsidian-canvas-bridge:auto-capture", false);
  const view = env.createView();
  t.after(() => view.onClose());
  await view.onOpen();
  return { ...env, view };
}

test("renders Canvas selection and patch cards alongside native Markdown and collapsed raw data", async () => {
  const renders = [];
  const { app, plugin, createView } = setup({
    async render(renderApp, markdown, container, source, component) {
      renders.push({ renderApp, markdown, source, component });
      const [heading, ...body] = markdown.split("\n");
      const paragraph = container.createEl(heading.startsWith("# ") ? "h1" : "p", { text: heading.replace(/^# /, "") });
      if (body.includes("[[Notes/Next]]")) {
        paragraph.createEl("a", { cls: "internal-link", text: "Next", attr: { "data-href": "Notes/Next" } });
      }
    },
  });
  const view = createView();
  view.list = new FakeElement();
  view.count = new FakeElement();
  const canvasPath = "Boards/Working.canvas";
  const nodes = [
    card("text", { text: "# 选区文字", color: "2", x: -8, y: 4 }),
    card("file", { type: "file", file: "Notes/A.md", color: "#abc" }),
    card("group", { type: "group", label: "资料分组" }),
    card("url", { type: "link", url: "https://example.com/" }),
  ];
  const edges = [{ id: "route", fromNode: "text", toNode: "file", fromSide: "right" }];
  const instruction = "查看现有选区并补充结果";
  const prompt = canvasContext.buildCanvasPromptEnvelope({
    userInstruction: instruction, mode: "edit_canvas", executor: "agy",
    canvasSnapshot: canvasContext.extractSelectionSnapshot({ nodes, edges }, nodes.map(node => node.id), canvasPath),
    fileExcerpts: { "Notes/A.md": "笔记摘录" },
  });
  const patch = {
    addNodes: [{ tempId: "receipt", text: "# 新增结果" }], updateNodes: [{ id: "text", x: 30 }],
    removeNodeIds: ["group"], updateEdges: [{ id: "route", toSide: "top" }],
  };
  const rawJson = JSON.stringify(patch, null, 2);
  const task = {
    id: "rich", executor: "agy", source: "Obsidian", status: "replied", prompt,
    reply: `# 回复标题\n[[Notes/Next]]\n\n\`\`\`canvas-patch\n${rawJson}\n\`\`\``,
  };
  plugin.canvasContext = { ...canvasContext, extractCanvasPatch: () => { assert.fail("Patch must only be parsed once"); } };
  const opened = [];
  const focused = [];
  app.workspace.openLinkText = (...args) => opened.push(args);
  plugin.focusCanvasNode = (...args) => focused.push(args);
  view.showTasks([task]);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(view.list.querySelector(".bc-user-instruction").innerText, instruction);
  assert.equal(view.list.querySelector(".bc-edge-summary").innerText, "内部 1 · 上游 0 · 下游 0");
  const selection = view.list.querySelector(".bc-card-grid").querySelectorAll(".bc-mini-card");
  assert.equal(selection.length, 4);
  assert.deepEqual(selection.map(item => item.querySelector(".bc-badge").innerText), ["文本", "笔记", "分组", "链接"]);
  assert.equal(selection[0].dataset.color, "2");
  assert.equal(selection[0].querySelector(".bc-card-geometry").innerText, "100×50 · (-8, 4)");
  assert.equal(selection[0].querySelector("h1").innerText, "选区文字");
  assert.equal(selection[1].dataset.color, "#abc");
  assert.equal(selection[1].style["--bc-node-color"], "#abc");
  assert.equal(selection[1].querySelector("details").open, false);
  assert.equal(selection[1].querySelector("p").innerText, "笔记摘录");
  assert.equal(selection[2].querySelector(".bc-card-body").innerText, "资料分组");
  assert.equal(selection[3].querySelector("a.external-link").getAttribute("href"), "https://example.com/");
  selection[0].querySelector(".bc-card-focus").onclick();
  assert.deepEqual(focused, [[canvasPath, "text"]]);

  const answer = view.list.querySelector(".bc-answer.markdown-rendered");
  assert.equal(answer.querySelector("h1").textContent, "回复标题");
  assert.doesNotMatch(answer.innerText, /canvas-patch|addNodes/);
  const contentLink = answer.querySelector("a.internal-link");
  const click = { target: contentLink, preventDefault() {}, stopPropagation() {} };
  answer.listeners.get("click")(click);
  selection[1].querySelector("a.internal-link").onclick(click);
  assert.deepEqual(opened, [["Notes/Next", canvasPath], ["Notes/A.md", canvasPath]]);

  const previews = view.list.querySelector(".bc-patch-cards").querySelectorAll(".bc-mini-card");
  assert.deepEqual(previews.map(item => item.dataset.kind), ["addNode", "updateNode", "removeNode", "edge"]);
  assert.deepEqual(previews.map(item => item.querySelector(".bc-badge").innerText), ["新增", "排版", "删除", "修改连线"]);
  assert.equal(previews[0].querySelector("h1").innerText, "新增结果");
  assert.equal(previews[3].querySelector(".bc-card-body").innerText, "选区文字 · right → A.md · top");
  const raw = view.list.querySelectorAll("details.bc-raw").filter(item => item.querySelector("pre"));
  assert.deepEqual(raw.map(item => [item.open, item.querySelector("summary").innerText, item.querySelector("pre").textContent]), [
    [false, "查看原始 Prompt", prompt], [false, "查看 Patch JSON", rawJson],
  ]);
  assert.equal(view.list.querySelector(".bc-patch-buttons").querySelector("button").innerText, "应用到画布");
  assert.deepEqual(renders.map(entry => entry.source), [canvasPath, "Notes/A.md", canvasPath, canvasPath]);
  const firstComponent = view.renderComponent;
  assert.ok(firstComponent);
  assert.ok(renders.every(entry => entry.renderApp === app && entry.component === firstComponent));

  view.showTasks([task]);
  assert.equal(view.renderComponent, firstComponent);
  view.showTasks([]);
  assert.equal(firstComponent.unloaded, true);
  const secondComponent = view.renderComponent;
  assert.notEqual(secondComponent, firstComponent);
  await view.onClose();
  assert.equal(secondComponent.unloaded, true);
  assert.equal(view.renderComponent, null);
  assert.deepEqual(view.children, []);
});

test("a patch action finishing after the view closes does not recreate the render component", async () => {
  const { createView, plugin } = setup({ render() {} });
  const view = createView();
  view.list = new FakeElement();
  view.count = new FakeElement();
  const task = {
    id: "patch", executor: "codex", status: "replied", canvasPath: "Board.canvas", selectedIds: ["node"],
    reply: '```canvas-patch\n{"updateNodes":[{"id":"node","text":"修改"}]}\n```',
  };
  let finish;
  plugin.applyReplyPatch = () => new Promise(resolve => { finish = resolve; });
  view.active = true;
  view.route = { tasks: [task] };
  view.showTasks(view.route.tasks);
  const applying = view.list.querySelector(".bc-patch-buttons").querySelector("button").onclick();
  await view.onClose();
  plugin.appliedPatches["codex:patch"] = true;
  finish(null);
  await applying;
  assert.equal(view.renderComponent, null);
  assert.deepEqual(view.children, []);
});

test("falls back to plain text without Obsidian Markdown APIs and keeps invalid patches out of the answer", () => {
  const { createView } = setup();
  const view = createView();
  view.list = new FakeElement();
  view.count = new FakeElement();
  const task = { id: "plain", status: "replied", prompt: "普通任务", reply: "**正文**\n\n```canvas-patch\n{bad}\n```" };
  view.showTasks([task]);
  assert.equal(view.renderComponent, null);
  assert.equal(view.list.querySelector(".bc-prompt").innerText, task.prompt);
  assert.equal(view.list.querySelector(".bc-answer").innerText, "**正文**");
  assert.equal(view.list.querySelector(".bc-patch-cards"), null);
  assert.equal(view.list.querySelector(".bc-raw").querySelector("pre").textContent, "{bad}");
  assert.match(view.list.querySelector(".bc-task-error").innerText, /Canvas Patch JSON 无法解析/);

  const reply = new FakeElement();
  view.addPatchActions(reply, { ...task, reply: '```canvas-patch\n{"addNodes":[]}\n```' }, {});
  assert.match(reply.querySelector(".bc-patch").innerText, /新增 0/);
});

test("focuses the live node in a matching open Canvas using selection and zoom alone", () => {
  const { plugin, leaves } = setup();
  const path = "Boards/Working.canvas";
  const liveNode = { id: "target" };
  const calls = [];
  const canvas = new Proxy({
    nodes: new Map([[liveNode.id, liveNode]]),
    selectOnly: node => calls.push(["select", node]),
    zoomToSelection: () => calls.push(["zoom"]),
  }, {
    get(target, key) {
      assert.ok(Object.hasOwn(target, key), `Unexpected Canvas API access: ${String(key)}`);
      return Reflect.get(target, key);
    },
  });
  const matching = leaf(undefined, canvas);
  matching.getViewState = () => ({ state: { file: path } });
  leaves.push(leaf({ path: "Other.canvas" }, canvas), leaf({ path }, { nodes: new Map() }), matching);
  plugin.focusCanvasNode("Closed.canvas", liveNode.id);
  plugin.focusCanvasNode(path, "missing");
  assert.deepEqual(calls, []);
  plugin.focusCanvasNode(path, liveNode.id);
  assert.deepEqual(calls, [["select", liveNode], ["zoom"]]);
  assert.equal(calls[0][1], liveNode);
});

test("remembers a Canvas leaf across sidebar focus and resolves relative Markdown cards", async () => {
  const { plugin, app, events, leaves, commands } = setup();
  const other = leaf({ path: "Other.canvas" }, { selection: new Set([{ id: "other" }]), getData: () => ({ nodes: [card("other")] }) });
  const md = { path: "Boards/notes.md", extension: "md" };
  const board = leaf({ path: "Boards/Board.canvas" }, {
    selection: new Set([{ id: "note" }]),
    resolveFilePath: file => file === "./notes.md" ? md : undefined,
  }, () => JSON.stringify({ nodes: [card("note", { type: "file", file: "./notes.md" })] }));
  app.vault.cachedRead = async file => { assert.equal(file, md); return 'repo: "G:\\Repo"\n' + "x".repeat(4000); };
  leaves.push(other, board);
  events.get("active-leaf-change")(board);
  events.get("active-leaf-change")({ view: { getViewType: () => "obsidian-canvas-bridge" } });

  const { snapshot, fileExcerpts } = await plugin.getCanvasSelection();
  assert.equal(snapshot.canvasPath, "Boards/Board.canvas");
  assert.equal(snapshot.detectedRepo, "G:\\Repo");
  assert.equal(fileExcerpts["./notes.md"].length, 4000);
  assert.ok(commands.includes("send-canvas-to-codex"));
  assert.ok(events.has("canvas:node-menu") && events.has("canvas:selection-menu"));
  leaves.pop();
  assert.equal((await plugin.getCanvasSelection()).snapshot.canvasPath, "Other.canvas");
});

test("builds a Codex dispatch payload without an AGY pairing", () => {
  const { createView } = setup();
  const view = createView();
  view.executor = "codex";
  view.route = { paired: false, codex_ready: true };
  view.workspacePath = "G:\\Vault";
  view.mode = "edit_canvas";
  view.repo = { value: "G:\\Repo" };
  view.context = { snapshot: canvasContext.extractSelectionSnapshot({ nodes: [card("a")] }, ["a"], "Board.canvas") };
  assert.equal(view.isReady(), true);
  const payload = view.dispatchPayload("改写");
  assert.equal(payload.action, "dispatch_codex");
  assert.equal(payload.target_workspace, "G:\\Repo");
  assert.equal(payload.canvas_path, "Board.canvas");
  assert.deepEqual(payload.selected_ids, ["a"]);
  assert.match(payload.text, /改写/);
});

test("renders rerun buttons only for blocked and notification_failed tasks", () => {
  const { createView } = setup();
  const view = createView();
  view.list = new FakeElement();
  view.count = new FakeElement();
  view.route = { paired: true };
  const task = status => ({ id: status, executor: "agy", status, prompt: `${status} task` });
  view.showTasks([
    task("blocked"), task("notification_failed"), task("replied"), task("running"),
    { ...task("blocked"), id: "blank", prompt: " \n " },
  ]);
  assert.deepEqual(view.list.querySelectorAll(".bc-rerun").map(button => button.closest(".bc-task").dataset.request), [
    "blocked", "notification_failed",
  ]);
});

test("clicks a blocked Codex task's rerun button, preserving the task and composer while blocking duplicates", async t => {
  const { view, plugin, saved } = await openRerunView(t);
  view.route = {
    codex_ready: true, codex_model: "provider/codex/current",
    codex_models: [
      { id: "provider/codex/current", efforts: ["low"] },
      { id: "provider/codex/original", efforts: ["high"] },
    ],
  };
  let refreshes = 0;
  view.refresh = async () => { refreshes++; view.updateHistory(); };
  view.input.value = "draft text";
  view.input.oninput();
  const draft = view.draft;
  const context = { snapshot: canvasContext.extractSelectionSnapshot({ nodes: [card("live")] }, ["live"], "live.canvas") };
  view.context = context;
  const task = {
    id: "blocked-codex", executor: "codex", status: "blocked", prompt: "原始 Codex 指令",
    mode: "edit_canvas", targetWorkspace: "G:\\Repo", canvasPath: "Board.canvas", selectedIds: ["node"],
    model: "provider/codex/original", effort: "high", stepGoal: "保留原步骤",
    token: "74f241af-bfba-40d7-92e1-9786639af853",
  };
  let resolveDispatch;
  const calls = [];
  plugin.callBridge = (workspace, payload) => {
    calls.push({ workspace, payload });
    return new Promise(resolve => { resolveDispatch = resolve; });
  };
  view.route.tasks = [task];
  view.updateHistory();
  const rerunButton = () => view.list.querySelector(".bc-rerun");
  assert.equal(rerunButton().getAttribute("type"), "button");
  const click = rerunButton().onclick;
  click();
  assert.equal(rerunButton().disabled, true);
  assert.equal(rerunButton().innerText, "重跑中…");
  click();
  rerunButton().onclick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workspace, view.workspacePath);
  const { token, ...payload } = calls[0].payload;
  assert.deepEqual(payload, {
    action: "rerun_codex", job_id: task.id, model: task.model, effort: task.effort,
  });
  assert.match(token, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  assert.notEqual(token, task.token);
  assert.notEqual(token, draft.token);
  resolveDispatch({ ok: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes, 1);
  assert.equal(rerunButton().disabled, false);
  assert.equal(rerunButton().innerText, "重跑");
  assert.equal(view.input.value, "draft text");
  assert.equal(view.draft, draft);
  assert.equal(draft.text, "draft text");
  assert.equal(saved.get("obsidian-canvas-bridge:draft"), draft);
  assert.equal(view.context, context);
  assert.equal(context.snapshot.canvasPath, "live.canvas");
  assert.deepEqual(context.snapshot.effectiveNodeIds, ["live"]);
  rerunButton().onclick();
  assert.equal(calls.length, 2);
  assert.notEqual(calls[1].payload.token, token);
  const cards = () => view.list.querySelectorAll(".bc-task").map(card => [card.dataset.request, card.dataset.status]);
  view.route.tasks = [{ ...task, status: "running" }];
  resolveDispatch({ ok: true, job_id: task.id });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cards(), [[task.id, "running"]]);
  view.route.tasks = [{ ...task, status: "replied", reply: "Codex 重跑成功" }];
  await view.refresh();
  assert.deepEqual(cards(), [[task.id, "replied"]]);
  assert.equal(view.input.value, "draft text");
  assert.equal(view.draft, draft);
  assert.equal(view.context, context);
});

test("falls back to the current Codex model and effort when the original selection is unavailable", () => {
  const { createView } = setup();
  const view = createView();
  view.workspacePath = "G:\\Vault";
  view.route = {
    codex_ready: true, codex_model: "provider/codex/current",
    codex_models: [{ id: "provider/codex/current", efforts: ["low"] }],
  };
  view.modelPrefs = { agy: "", codex: "provider/codex/current", codexEffort: "low" };
  const task = {
    id: "archived-codex", executor: "codex", status: "blocked", prompt: "重跑",
    model: "provider/codex/removed", effort: "high",
  };
  assert.deepEqual({ ...view.rerunPayload(task) }, {
    action: "rerun_codex", job_id: task.id, model: "provider/codex/current", effort: "low",
  });
  view.route.codex_model = task.model;
  assert.equal(view.rerunPayload(task).model, task.model);
  view.route.codex_model = "";
  view.route.codex_models = [];
  assert.deepEqual({ ...view.rerunPayload(task) }, {
    action: "rerun_codex", job_id: task.id, model: task.model, effort: task.effort,
  });
});

test("reruns AGY and custom provider tasks and refreshes their task sources", async t => {
  const { view, plugin } = await openRerunView(t);
  let bridgeRefreshes = 0;
  let providerRefreshes = 0;
  view.refresh = async () => { bridgeRefreshes++; };
  view.refreshProviders = async () => { providerRefreshes++; };
  const agyCalls = [];
  plugin.callBridge = async (_workspace, payload) => { agyCalls.push(payload); return { ok: true }; };
  view.route = { paired: true, project: "project", conversation: "conversation" };
  const agyTask = { id: "agy-blocked", status: "blocked", prompt: "AGY 重跑", model: "agy-original" };
  view.showTasks([agyTask]);
  await view.rerunTask(agyTask);
  assert.equal(agyCalls.length, 1);
  const { token: agyToken, ...agyPayload } = agyCalls[0];
  assert.ok(agyToken);
  assert.deepEqual(agyPayload, {
    action: "send", project: "project", conversation: "conversation", text: agyTask.prompt,
    replace_request_id: agyTask.id, model: agyTask.model,
  });
  assert.equal(bridgeRefreshes, 1);
  assert.equal(providerRefreshes, 0);

  const providerCalls = [];
  let finish;
  const settled = new Promise(resolve => { finish = resolve; });
  const provider = {
    id: "reviewer", label: "Reviewer", enabled: true,
    getStatus: () => ({ ready: true }), listTasks: () => [],
    dispatch: async payload => { providerCalls.push(payload); return { ok: true, settled }; },
  };
  plugin.registerProvider(provider);
  providerRefreshes = 0;
  view.providerStates.set(provider.id, { adapter: provider, value: { ready: true } });
  const customTask = {
    id: "provider-blocked", executor: provider.id, status: "blocked", prompt: "Provider 重跑",
    mode: "execute_task", targetWorkspace: "G:\\Review", canvasPath: "Review.canvas", selectedIds: ["review"],
    source: "Extension", model: "provider-original", effort: "high",
  };
  view.showTasks([customTask]);
  await view.rerunTask(customTask);
  assert.equal(providerCalls.length, 1);
  const { token: providerToken, ...providerPayload } = providerCalls[0];
  assert.ok(providerToken);
  assert.deepEqual(providerPayload, {
    workspace: view.workspacePath, targetWorkspace: customTask.targetWorkspace, executor: provider.id,
    mode: customTask.mode, prompt: customTask.prompt, canvasPath: customTask.canvasPath, selectedIds: customTask.selectedIds,
    source: customTask.source, rerunId: customTask.id, model: customTask.model, effort: customTask.effort,
  });
  assert.deepEqual([bridgeRefreshes, providerRefreshes], [1, 1]);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([bridgeRefreshes, providerRefreshes], [1, 2]);
});

test("reruns a blocked OpenAI-compatible HTTP task and shows the new reply in history", async t => {
  const requests = [];
  let finish;
  const { view, plugin } = await openRerunView(t, {
    settings: { openaiProviders: [{ id: "local-api", enabled: true, models: "default,original", defaultModel: "default" }] },
    requestUrl(request) {
      requests.push(request);
      if (requests.length === 1) return { status: 503, json: { error: { message: "暂时不可用" } } };
      return new Promise(resolve => { finish = resolve; });
    },
  });
  const adapter = plugin.providers.get("local-api");
  const original = await adapter.dispatch({
    workspace: view.workspacePath, prompt: "保留 HTTP 指令", model: "original",
    canvasPath: "HTTP.canvas", selectedIds: ["http"], token: "original-token",
  }).settled;
  assert.equal(original.status, "blocked");
  await view.refreshProviders();
  const cards = () => view.list.querySelectorAll(".bc-task").map(task => [task.dataset.request, task.dataset.status]);
  assert.deepEqual(cards(), [[original.id, "blocked"]]);
  view.list.querySelector(".bc-rerun").onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cards(), [[original.id, "running"]]);
  assert.equal(requests.length, 2);
  const request = JSON.parse(requests[1].body);
  assert.equal(request.model, original.model);
  assert.deepEqual(request.messages.at(-1), { role: "user", content: original.prompt });
  finish({ status: 200, json: { choices: [{ message: { content: "重跑成功" } }] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cards(), [[original.id, "replied"]]);
  assert.equal(view.list.querySelector(".bc-answer").innerText, "重跑成功");
  const tasks = plugin.localTaskStore.list(view.workspacePath);
  assert.equal(tasks.length, 1);
  const [retried] = tasks;
  assert.equal(retried.id, original.id);
  assert.equal(retried.time, original.time);
  assert.equal(retried.canvasPath, original.canvasPath);
  assert.deepEqual(Array.from(retried.selectedIds), ["http"]);
});

test("re-enables rerun on updateHistory when routes or the current provider become ready", async t => {
  const { view, plugin, notices } = await openRerunView(t, { render() {} });
  const agyTask = { id: "not-paired", executor: "agy", status: "blocked", prompt: "等待配对" };
  const codexTask = { id: "codex-wait", executor: "codex", status: "notification_failed", prompt: "等待 Codex" };
  const provider = {
    id: "reviewer", label: "Reviewer", enabled: true, getStatus: () => ({ ready: true }), listTasks: () => [],
    dispatch: () => assert.fail("An unavailable provider must not receive a rerun"),
  };
  plugin.registerProvider(provider);
  const providerTask = { id: "not-ready", executor: provider.id, providerLabel: provider.label, status: "blocked", prompt: "等待服务" };
  view.route = { paired: false, reason: "需要先配对", codex_error: "缺少 Codex 配置", tasks: [agyTask, codexTask] };
  view.providerTasks = [providerTask];
  view.providerStates.set(provider.id, { adapter: provider, value: { ready: false, message: "服务未就绪" } });
  const buttons = () => view.list.querySelectorAll(".bc-rerun");
  view.updateHistory();
  assert.deepEqual(buttons().map(button => [button.disabled, button.title]), [
    [true, "需要先配对"], [true, "缺少 Codex 配置"], [true, "服务未就绪"],
  ]);
  await view.rerunTask(providerTask);
  assert.equal(view.feedback.innerText, "服务未就绪");
  assert.equal(notices.at(-1), "服务未就绪");

  view.route = { ...view.route, paired: true, codex_ready: true };
  view.providerStates.set(provider.id, { adapter: { ...provider }, value: { ready: true } });
  view.updateHistory();
  assert.deepEqual(buttons().map(button => button.disabled), [false, false, true]);
  assert.equal(buttons().at(-1).title, "Reviewer 未就绪");
  view.providerStates.set(provider.id, { adapter: provider, value: { ready: true } });
  view.updateHistory();
  assert.deepEqual(buttons().map(button => button.disabled), [false, false, false]);
  const component = view.renderComponent;
  const readyButtons = buttons();
  view.updateHistory();
  assert.equal(view.renderComponent, component);
  assert.deepEqual(buttons(), readyButtons);
});

test("reports rejected reruns and restores the action when history is unchanged", async t => {
  const { view, plugin, notices } = await openRerunView(t);
  const task = { id: "rejected", executor: "codex", status: "blocked", prompt: "重试" };
  view.route = { codex_ready: true, tasks: [task] };
  view.refresh = async () => view.updateHistory();
  plugin.callBridge = async () => ({ ok: false, error: "请求被拒绝" });
  view.updateHistory();
  await view.rerunTask(task);
  assert.equal(view.feedback.innerText, "请求被拒绝");
  assert.equal(notices.at(-1), "重跑失败 · 请求被拒绝");
  assert.equal(view.list.querySelector(".bc-rerun").disabled, false);

  let reject;
  const settled = new Promise((_, rejectPromise) => { reject = rejectPromise; });
  plugin.callBridge = async () => ({ ok: true, settled });
  await view.rerunTask(task);
  reject(new Error("后续执行失败"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.feedback.innerText, "后续执行失败");
  assert.equal(view.list.querySelector(".bc-rerun").disabled, false);
});

test("passes the Canvas and IDs from both native context-menu events", () => {
  const { plugin, events } = setup();
  const captured = [];
  plugin.captureInPanel = ({ hint }) => captured.push([hint.canvas, Array.from(hint.ids)]);
  const menu = { addItem: register => register({
    setTitle() { return this; }, setIcon() { return this; }, onClick(click) { click(); },
  }) };
  const canvas = { selection: new Set([{ id: "a" }, { id: "b" }]) };
  events.get("canvas:node-menu")(menu, { id: "a", canvas });
  events.get("canvas:selection-menu")(menu, canvas);
  assert.deepEqual(captured, [[canvas, ["a"]], [canvas, ["a", "b"]]]);
});

test("writes an open Canvas through its view and a closed Canvas through vault.process", async () => {
  const { plugin, app, leaves, saved } = setup();
  const file = { path: "Board.canvas", extension: "canvas" };
  const context = { canvasPath: file.path, selectedIds: ["selected"] };
  let liveData = { nodes: [card("selected"), card("outside")], edges: [], custom: 42 };
  let disk = JSON.stringify(liveData);
  let requested = 0;
  let processed = 0;
  const live = leaf(file, {
    getData: () => liveData,
    setData: next => { liveData = next; },
    requestSave: () => { requested++; },
  });
  app.vault.getFileByPath = () => file;
  app.vault.process = async (_file, transform) => { processed++; disk = transform(disk); };
  const patch = { updateNodes: [{ id: "selected", text: "new" }, { id: "outside", text: "wrong" }] };

  leaves.push(live);
  assert.equal((await plugin.applyReplyPatch("codex:open", context, patch)).skipped, 1);
  assert.equal(await plugin.applyReplyPatch("codex:open", context, patch), null);
  assert.deepEqual([requested, processed, liveData.nodes[0].text, liveData.nodes[1].text, liveData.custom], [1, 0, "new", undefined, 42]);
  leaves.pop();
  assert.equal((await plugin.applyReplyPatch("agy:closed", context, patch)).updated, 1);
  assert.deepEqual([requested, processed, JSON.parse(disk).nodes[0].text], [1, 1, "new"]);
  assert.ok(saved.get("obsidian-canvas-bridge:applied")["agy:closed"]);
});

test("loads canvas_context.js under an Obsidian-like require without .cache or file requires", () => {
  const globalDir = path.join(__dirname, "..");
  const parentDir = path.dirname(globalDir);
  const pluginDirName = path.basename(globalDir);
  const module = { exports: {} };
  const app = {
    workspace: { getMostRecentLeaf: () => null, on: () => ({}) },
    vault: { adapter: { getBasePath: () => parentDir } },
    loadLocalStorage: () => undefined,
    saveLocalStorage: () => {},
  };
  class Plugin {
    constructor() { this.app = app; this.manifest = { dir: pluginDirName }; }
    registerView() {}
    addRibbonIcon() {}
    addCommand() {}
    registerEvent() {}
  }
  class ItemView { constructor() { this.app = app; } }
  class Scope { register() {} }
  const allowedBuiltins = new Set(["node:child_process", "node:crypto", "node:fs", "node:os", "node:path"]);
  const obsidianRequire = id => {
    if (id === "obsidian") return { Plugin, ItemView, Scope, Notice: class {}, setIcon() {} };
    if (allowedBuiltins.has(id)) return require(id);
    throw new Error(`Obsidian require cannot resolve module: ${id}`);
  };
  assert.equal(obsidianRequire.cache, undefined);

  vm.runInNewContext(main, { module, require: obsidianRequire });
  const plugin = new module.exports();
  plugin.onload();
  assert.equal(plugin.canvasLoadError, "");
  assert.equal(typeof plugin.canvasContext?.extractSelectionSnapshot, "function");
  assert.equal(typeof plugin.canvasContext?.applyCanvasPatch, "function");

  const snap = plugin.canvasContext.extractSelectionSnapshot({ nodes: [card("a", { text: "hello" })], edges: [] }, ["a"], "Test.canvas");
  assert.deepEqual(Array.from(snap.effectiveNodeIds), ["a"]);
  const patched = plugin.canvasContext.applyCanvasPatch({ nodes: [card("a", { text: "hello" })], edges: [] }, {
    updateNodes: [{ id: "a", text: "updated" }],
  }, { allowedNodeIds: ["a"] });
  assert.equal(patched.data.nodes[0].text, "updated");
});

test("auto-captures canvas selection by default, deduplicates, preserves manual repo, and stops when toggled off", async () => {
  const { plugin, app, leaves, saved, createView } = setup();
  const view = createView();
  const attrs = {};
  view.active = true;
  view.repo = { value: "", readOnly: false };
  view.autoToggle = { disabled: false, setAttribute: (k, v) => { attrs[k] = v; } };
  view.capture = { disabled: false };
  view.clear = { disabled: false, hidden: true };
  view.repoRow = { hidden: true };
  view.selectionLabel = { setText() {}, title: "" };
  view.indicator = { setText() {}, dataset: {} };
  view.vaultLabel = { title: "" };
  view.feedback = { setText() {} };
  view.input = { placeholder: "", value: "", readOnly: false };
  view.submit = { disabled: false };
  view.submitText = { setText() {} };
  view.executorButtons = [];
  view.modeButtons = [];
  view.autoCapture = app.loadLocalStorage("obsidian-canvas-bridge:auto-capture") !== false;
  assert.equal(view.autoCapture, true);

  const sel = new Set([{ id: "n1" }]);
  const board = leaf({ path: "Board.canvas" }, {
    selection: sel,
    getData: () => ({ nodes: [card("n1", { text: "one" }), card("n2", { text: "two" })], edges: [] }),
  });
  leaves.push(board);

  await view.syncAutoSelection();
  assert.deepEqual(Array.from(view.context.snapshot.directSelectedIds), ["n1"]);

  // Manual repo edit on the same canvas should survive auto-capture of a new selection
  view.repo.value = "G:\\Project";
  view.repoManual = true;
  const prevVersion = view.captureVersion;
  await view.syncAutoSelection();
  assert.equal(view.captureVersion, prevVersion);

  sel.clear();
  sel.add({ id: "n2" });
  await view.syncAutoSelection();
  assert.deepEqual(Array.from(view.context.snapshot.directSelectedIds), ["n2"]);
  assert.equal(view.repo.value, "G:\\Project");

  // Clearing suppresses immediate re-capture of the exact same selection, until selection changes
  view.clearSelection();
  assert.equal(view.context, null);
  await view.syncAutoSelection();
  assert.equal(view.context, null);

  sel.clear();
  sel.add({ id: "n1" });
  await view.syncAutoSelection();
  assert.deepEqual(Array.from(view.context.snapshot.directSelectedIds), ["n1"]);

  // Toggling off disables auto-capture and persists preference
  view.toggleAutoCapture();
  assert.equal(view.autoCapture, false);
  assert.equal(saved.get("obsidian-canvas-bridge:auto-capture"), false);
  assert.equal(attrs["aria-pressed"], "false");
  sel.clear();
  sel.add({ id: "n2" });
  await view.syncAutoSelection();
  assert.deepEqual(Array.from(view.context.snapshot.directSelectedIds), ["n1"]);
});

test("dynamically populates AGY/Codex models and efforts, persists selection, and passes them in payload", () => {
  const { app, saved, createView } = setup();
  const makeSelect = () => {
    const el = {
      options: [], value: "", disabled: false,
      empty() { this.options = []; },
      createEl(_tag, opts) {
        const opt = { value: opts.attr.value, text: opts.text, title: opts.attr.title };
        this.options.push(opt);
        return opt;
      },
    };
    return el;
  };
  const view = createView();
  view.modelPrefs = { agy: "", codex: "", codexEffort: "" };
  view.modelSelect = makeSelect();
  view.effortSelect = makeSelect();
  view.effortWrap = { hidden: false };
  view.repo = { value: "", readOnly: false };
  view.capture = { disabled: false };
  view.clear = { disabled: false, hidden: true };
  view.repoRow = { hidden: true };
  view.selectionLabel = { setText() {}, title: "" };
  view.indicator = { setText() {}, dataset: {} };
  view.vaultLabel = { title: "" };
  view.feedback = { setText() {} };
  view.input = { placeholder: "", value: "", readOnly: false };
  view.submit = { disabled: false };
  view.submitText = { setText() {} };
  view.executorButtons = [];
  view.modeButtons = [];
  view.workspacePath = "G:\\Vault\\Design";
  view.route = {
    paired: true, project: "p1", conversation: "c1",
    codex_ready: true, codex_model: "provider/codex/model-a", codex_default_effort: "high",
    codex_models: [
      { id: "provider/codex/model-a", label: "Model A", efforts: ["low", "high"], defaultEffort: "low" },
      { id: "provider/codex/model-b", label: "Model B", efforts: ["high", "xhigh"], defaultEffort: "high" },
    ],
    agy_models: [
      { id: "example-model-a", label: "Example Model A" },
      { id: "example-model-b", label: "Example Model B" },
    ],
  };

  // AGY mode: defaults to follow-conversation ("")
  view.updateComposer();
  assert.equal(view.effortWrap.hidden, true);
  assert.deepEqual(Array.from(view.modelSelect.options, o => o.value), ["", "example-model-a", "example-model-b"]);
  assert.equal(view.dispatchPayload("hello").model, undefined);

  // Select specific AGY model
  view.modelSelect.value = "example-model-b";
  view.onModelChange();
  assert.equal(view.dispatchPayload("hello").model, "example-model-b");
  assert.equal(saved.get("obsidian-canvas-bridge:models").agy, "example-model-b");

  // Switch to Codex: populates codex models & efforts, skips DOM rebuild if options unchanged
  view.setExecutor("codex");
  assert.equal(view.effortWrap.hidden, false);
  assert.deepEqual(Array.from(view.modelSelect.options, o => o.value), ["provider/codex/model-a", "provider/codex/model-b"]);
  assert.deepEqual(Array.from(view.effortSelect.options, o => o.value), ["low", "high"]);
  const sameOptsRef = view.modelSelect.options;
  view.updateComposer();
  assert.equal(view.modelSelect.options, sameOptsRef);

  view.modelSelect.value = "provider/codex/model-b";
  view.onModelChange();
  assert.deepEqual(Array.from(view.effortSelect.options, o => o.value), ["high", "xhigh"]);
  view.effortSelect.value = "xhigh";
  view.onEffortChange();
  const payload = view.dispatchPayload("改画布");
  assert.equal(payload.model, "provider/codex/model-b");
  assert.equal(payload.effort, "xhigh");
});

test("defaults to edit_canvas mode, applies/reverts safely via importData + pushHistory without markDirty", async () => {
  const { plugin, app, leaves, saved, createView } = setup();
  const view = createView();
  assert.equal(view.mode, "edit_canvas");

  const file = { path: "Layout.canvas", extension: "canvas" };
  let liveData = { nodes: [card("s1", { x: 0, y: 0, width: 250, height: 60, text: "before" }), card("outside", { x: 500, y: 500 })], edges: [] };
  let disk = JSON.stringify(liveData);
  const calls = [];
  const history = [];
  const liveLeaf = leaf(file, {
    history: { data: history },
    getData: () => liveData,
    deselectAll: () => calls.push("deselectAll"),
    pushHistory: snap => { history.push(snap); calls.push("pushHistory"); },
    importData: (next, keepHistory) => { liveData = next; calls.push(["importData", keepHistory]); },
    setData: () => { throw new Error("should prefer importData"); },
    markDirty: () => { throw new Error("must not call markDirty without item"); },
    requestSave: (...args) => calls.push(["requestSave", args.length]),
  });
  leaves.push(liveLeaf);
  app.vault.getFileByPath = () => file;
  app.vault.process = async (_file, transform) => { disk = transform(disk); };

  const patch = { updateNodes: [{ id: "s1", x: -820, y: -710, width: 360, height: 100, text: "after" }, { id: "outside", x: 1, y: 1 }] };
  const summary = await plugin.applyReplyPatch("codex:layout-1", { canvasPath: file.path, selectedIds: ["s1"] }, patch);
  assert.equal(summary.updated, 1);
  assert.equal(summary.skipped, 1);
  assert.deepEqual([liveData.nodes[0].x, liveData.nodes[0].y, liveData.nodes[0].width, liveData.nodes[0].height, liveData.nodes[0].text], [-820, -710, 360, 100, "after"]);
  assert.deepEqual([liveData.nodes[1].x, liveData.nodes[1].y], [500, 500]);
  assert.ok(calls.includes("deselectAll"));
  assert.equal(calls.filter(c => c === "pushHistory").length, 2);
  assert.equal(JSON.stringify(calls.find(c => Array.isArray(c) && c[0] === "importData")), '["importData",true]');
  assert.equal(JSON.stringify(calls.find(c => Array.isArray(c) && c[0] === "requestSave")), '["requestSave",0]');
  assert.ok(saved.get("obsidian-canvas-bridge:applied")["codex:layout-1"].undo);

  // Revert open canvas restores original coordinates and text, and clears applied marker
  const revOpen = await plugin.revertReplyPatch("codex:layout-1");
  assert.equal(revOpen.restoredNodes, 1);
  assert.deepEqual([liveData.nodes[0].x, liveData.nodes[0].y, liveData.nodes[0].width, liveData.nodes[0].height, liveData.nodes[0].text], [0, 0, 250, 60, "before"]);
  assert.equal(Object.hasOwn(saved.get("obsidian-canvas-bridge:applied"), "codex:layout-1"), false);

  // Closed canvas apply + revert via vault.process
  leaves.pop();
  const sumClosed = await plugin.applyReplyPatch("codex:layout-closed", { canvasPath: file.path, selectedIds: ["s1"] }, patch);
  assert.equal(sumClosed.updated, 1);
  assert.equal(JSON.parse(disk).nodes[0].x, -820);
  const revClosed = await plugin.revertReplyPatch("codex:layout-closed");
  assert.equal(revClosed.restoredNodes, 1);
  assert.deepEqual([JSON.parse(disk).nodes[0].x, JSON.parse(disk).nodes[0].text], [0, "before"]);
});

test("loads the standalone modules under a restricted Obsidian require", async () => {
  const { plugin, files, obsidianRequire } = setup({ realModules: true });
  await plugin.settingsReady;
  assert.equal(obsidianRequire.cache, undefined);
  assert.throws(() => obsidianRequire("./providers.js"), /cannot resolve/);
  assert.deepEqual(files, ["canvas_context.js", "kanban_context.js", "providers.js"]);
  assert.equal(typeof plugin.canvasContext.applyCanvasPatch, "function");
  assert.equal(typeof plugin.kanbanContext.applyKanbanBodyEdits, "function");
  assert.equal(typeof plugin.providerModule.normalizeChatCompletionsUrl, "function");
  assert.deepEqual(Array.from(plugin.getProviders(), item => item.id), ["openai-compatible"]);
});

function kanbanFixture(env) {
  const { app, leaves } = env;
  const options = ["待办", "进行中", "等待对接", "已完成"];
  const files = ["A", "B", "C"].map(basename => ({ path: `Tasks/${basename}.md`, basename, extension: "md" }));
  const [a, b, c] = files;
  const frontmatter = new Map([
    [a, { 状态: "待办", updated: "2000-01-01", week: "本周", repo: "/workspace/a" }],
    [b, { 状态: "已完成", week: "本周" }], [c, { 状态: "待办", week: "本周" }],
  ]);
  const serialize = fm => `---\n${testStringifyYaml(fm)}---\n`;
  const raw = new Map(files.map(file => [file, serialize(frontmatter.get(file)) + "- [ ] 验证结果\n## 实时进展与记录\n关联：[[项目]]\n"]));
  const writes = [];
  app.metadataCache ||= {};
  app.metadataCache.getFileCache = file => ({ frontmatter: frontmatter.get(file) });
  Object.assign(app.vault, {
    getFileByPath: value => files.find(file => file.path === value),
    cachedRead: async file => raw.get(file), read: async file => raw.get(file),
    process: async (file, edit) => {
      const next = edit(raw.get(file));
      raw.set(file, next);
      frontmatter.set(file, testParseYaml(testFrontMatterInfo(next).frontmatter));
    },
  });
  app.fileManager = { processFrontMatter: async (file, edit) => {
    const fm = frontmatter.get(file);
    const body = raw.get(file).slice(serialize(fm).length);
    edit(fm);
    raw.set(file, serialize(fm) + body);
    writes.push(file.path);
  } };
  const containerEl = new FakeElement();
  const subView = {
    type: "kanban", containerEl, orderedGroups: [{ key: { data: "本周" } }],
    columns: [], config: { get: key => key === "groupBy" ? { property: "note.week" } : undefined },
  };
  const board = { view: { getViewType: () => "bases", controller: {
    view: subView, viewName: "按周", query: { views: [
      { type: "table", groupBy: { property: "note.status" } },
      { type: "kanban", groupBy: { property: "note.状态" }, groupOrder: options },
    ] },
  } }, getViewState: () => ({ state: { file: "Boards/Tasks.base" } }) };
  const columnEl = containerEl.createDiv();
  const items = [a, b].map(file => ({ entry: { file }, el: columnEl.createDiv({ cls: "bases-kanban-card" }) }));
  subView.columns = new Set([{ group: { key: { data: "本周" }, entries: files.map(file => ({ file })) }, items, containerEl: columnEl }]);
  app.workspace.activeLeaf = board;
  leaves.push(board);
  return { board, subView, containerEl, columnEl, items, files, a, b, c, options, frontmatter, raw, statusWrites: writes };
}

test("reinstalls Kanban overlays across virtual renders and keeps click, drag, and recycled card bindings scoped", async t => {
  let metadataChanged;
  let nextTimer = 0;
  const timers = new Map();
  const env = setup({ realModules: true, metadataCache: { on: (_event, handler) => { metadataChanged = handler; } }, timers: {
    setTimeout: handler => { timers.set(++nextTimer, handler); return nextTimer; },
    clearTimeout: id => timers.delete(id),
  } });
  const { plugin, events, commandCallbacks } = env;
  await plugin.settingsReady;
  t.after(() => plugin.onunload());
  const { board, subView, containerEl, items, a, b, c } = kanbanFixture(env);
  const observed = [];
  containerEl.ownerDocument = { defaultView: { MutationObserver: class {
    constructor(callback) { this.trigger = callback; observed.push(this); }
    observe(target, options) { Object.assign(this, { target, options }); }
    disconnect() { this.closed = true; }
  } } };
  const captures = [];
  plugin.captureKanbanCardInPanel = hint => captures.push(hint);
  const flush = () => { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } };
  events.get("active-leaf-change")(board);
  events.get("layout-change")();
  assert.equal(timers.size, 1);
  flush();
  assert.equal(plugin.lastBasesLeaf, board);
  assert.equal(observed[0].target, containerEl);
  assert.equal(observed[0].options.subtree, true);
  const el = items[0].el;
  const overlay = el.querySelector(".bc-kanban-overlay");
  plugin.syncKanbanBoards();
  assert.equal(el.querySelector(".bc-kanban-overlay"), overlay);
  assert.equal(el.dataset.bcFile, a.path);
  assert.equal(overlay.querySelector(".bc-kanban-status-chip").textContent, "待办");
  const button = overlay.querySelector(".bc-kanban-dispatch-btn");
  let stopped = 0;
  let prevented = 0;
  const event = { target: button, stopPropagation: () => { stopped++; }, preventDefault: () => { prevented++; } };
  button.listeners.get("pointerdown")(event);
  button.listeners.get("mousedown")(event);
  button.onclick(event);
  containerEl.listeners.get("click")({ ...event, target: items[1].el, altKey: true, shiftKey: true });
  assert.equal(stopped, 4);
  assert.equal(prevented, 3);
  assert.deepEqual(captures.map(hint => [hint.file.path, Boolean(hint.additive)]), [[a.path, false], [b.path, true]]);
  el.empty();
  items[0].entry.file = c;
  observed[0].trigger();
  metadataChanged();
  assert.equal(timers.size, 1);
  flush();
  assert.equal(el.dataset.bcFile, c.path);
  assert.equal(el.querySelectorAll(".bc-kanban-overlay").length, 1);
  assert.notEqual(el.querySelector(".bc-kanban-overlay"), overlay);
  el.querySelector(".bc-kanban-dispatch-btn").onclick(event);
  assert.equal(captures.at(-1).file, c);
  assert.ok(commandCallbacks.has("capture-kanban-card"));
  subView.type = "table";
  events.get("layout-change")();
  flush();
  assert.equal(el.querySelector(".bc-kanban-overlay"), null);
  assert.equal(observed[0].closed, true);
  assert.equal(containerEl.listeners.size, 0);
});

test("captures, locates, and manually updates Kanban cards using a sibling status view", async t => {
  const env = await openRerunView(t, { settings: { openaiProviders: [{ id: "local-api", enabled: true }] } });
  const { plugin, view, app, events, commandCallbacks } = env;
  t.after(() => plugin.onunload());
  const { board, subView, items, a, b, c, options, frontmatter } = kanbanFixture(env);
  plugin.openPanel = async () => view;
  events.get("active-leaf-change")(board);
  const capture = await plugin.captureKanbanCardInPanel({ leaf: board, file: a, column: "本周" });
  assert.equal(capture.snapshot.boardPath, "Boards/Tasks.base");
  assert.equal(capture.snapshot.viewName, "按周");
  assert.equal(capture.snapshot.groupBy, "week");
  assert.deepEqual(Array.from(capture.snapshot.groupOrder), ["本周"]);
  assert.equal(capture.snapshot.statusProperty, "状态");
  assert.deepEqual(Array.from(capture.snapshot.statusOptions), options);
  assert.equal(view.mode, "execute_task");
  assert.equal(view.repo.value, "/workspace/a");
  assert.equal(view.kanbanBar.hidden, false);
  assert.equal(view.kanbanStatusSelect.options.length, options.length + 1);
  assert.match(view.modeGroup.innerText, /改卡片\/状态/);
  await plugin.captureKanbanCardInPanel({ leaf: board, file: b, column: "本周", additive: true });
  plugin.syncKanbanBoards();
  assert.ok(items.every(({ el }) => el.classList.contains("bc-kanban-selected")));
  view.kanbanStatusSelect.value = "等待对接";
  await view.kanbanStatusSelect.onchange();
  assert.equal(frontmatter.get(a).状态, "等待对接");
  assert.equal(frontmatter.get(a).updated, kanbanContext.todayLocalYmd());
  assert.equal(frontmatter.get(b).状态, "等待对接");
  assert.equal(Object.hasOwn(frontmatter.get(b), "updated"), false);
  assert.equal(frontmatter.get(c).状态, "待办");
  let revealed;
  app.workspace.revealLeaf = async leaf => { revealed = leaf; };
  assert.equal(await plugin.focusKanbanCard("Boards/Tasks.base", b.path), true);
  assert.equal(revealed, board);
  assert.equal(items[1].el.focused, true);
  const [col] = subView.columns;
  col.contentEl = { scrollTop: 0 };
  subView.measurements = { cardHeight: 100, cardGap: 10 };
  col.updateVirtualDisplay = () => {
    assert.equal(col.contentEl.scrollTop, 220);
    col.items.push({ entry: { file: c }, el: col.containerEl.createDiv({ cls: "bases-kanban-card" }) });
  };
  assert.equal(await plugin.focusKanbanCard("Boards/Tasks.base", c.path), true);
  assert.equal(col.items.at(-1).el.scrolled, true);
  const menu = { entries: [], addItem(add) {
    const item = { setTitle(title) { this.title = title; return this; }, setIcon() { return this; }, onClick(fn) { this.click = fn; } };
    add(item); this.entries.push(item);
  } };
  plugin.settings.enableBridge = true;
  events.get("file-menu")(menu, c);
  assert.deepEqual(menu.entries.map(item => item.title), ["抓取卡片到协作对话", "用 Codex 派活", "用 AGY 派活"]);
  await menu.entries[0].click();
  assert.equal(view.context.snapshot.cards[0].path, c.path);
  plugin.syncKanbanBoards();
  subView.containerEl.listeners.get("pointerover")({ target: items[0].el });
  await commandCallbacks.get("capture-kanban-card")();
  assert.equal(view.context.snapshot.cards[0].path, a.path);
  view.autoCapture = true;
  await view.syncAutoSelection();
  assert.equal(view.context.kind, "kanban");
});

test("dispatches Kanban cards via Codex and AGY and advances only live initial statuses after acceptance", async t => {
  const env = await openRerunView(t);
  const { plugin, view, saved } = env;
  t.after(() => plugin.onunload());
  const { board, a, b, frontmatter, statusWrites } = kanbanFixture(env);
  plugin.openPanel = async () => view;
  view.route = { paired: true, codex_ready: true, project: "p", conversation: "c" };
  view.registration = null;
  view.refresh = async () => {};
  view.updateComposer();
  view.setExecutor("codex");
  await plugin.captureKanbanCardInPanel({ leaf: board, file: a });
  await plugin.captureKanbanCardInPanel({ leaf: board, file: b, additive: true });
  const calls = [];
  plugin.callBridge = async (_workspace, payload) => { calls.push(payload); return { ok: calls.length > 1, error: "当前不可用" }; };
  assert.equal(view.kanbanAutoToggle.checked, true);
  view.kanbanAutoToggle.checked = false;
  view.kanbanAutoToggle.onchange();
  assert.equal(saved.get("obsidian-canvas-bridge:kanban-auto-status"), false);
  view.kanbanAutoToggle.checked = true;
  view.kanbanAutoToggle.onchange();
  assert.equal(saved.get("obsidian-canvas-bridge:kanban-auto-status"), true);
  await view.kanbanQuickSend.onclick();
  assert.equal(frontmatter.get(a).状态, "待办");
  assert.deepEqual(statusWrites, []);
  await view.kanbanQuickSend.onclick();
  const { metadata, instruction } = kanbanContext.parseKanbanPromptEnvelope(calls[1].text);
  assert.equal(calls[1].action, "dispatch_codex");
  assert.equal(calls[1].token, calls[0].token);
  assert.equal(calls[1].board_path, "Boards/Tasks.base");
  assert.deepEqual(Array.from(calls[1].card_paths), [a.path, b.path]);
  assert.equal(metadata.targetWorkspace, "/workspace/a");
  assert.match(instruction, /kanban-patch/);
  assert.equal(frontmatter.get(a).状态, "进行中");
  assert.equal(frontmatter.get(b).状态, "已完成");
  view.setExecutor("agy");
  const agy = view.dispatchPayload("检查结果");
  assert.equal(agy.action, "send");
  assert.equal(kanbanContext.parseKanbanPromptEnvelope(agy.text).metadata.executor, "agy");
});

test("previews and applies locked Kanban reply updates through HTTP history, then restores raw content", async t => {
  const reply = '已核对结果。\n\n```kanban-patch\n{"updates":[{"file":"Tasks/A.md","status":"已完成","properties":{"priority":2},"appendProgress":"完成回归","checkTasks":["验证结果"]},{"file":"Tasks/B.md","status":"待办"}]}\n```';
  const env = await openRerunView(t, {
    settings: { enableBridge: false, openaiProviders: [{ id: "openai-compatible", name: "API", enabled: true, baseUrl: "https://example.test/v1", models: ["test-model"] }] },
    requestUrl: async () => ({ status: 200, json: { choices: [{ message: { content: reply } }] } }),
  });
  const { plugin, view, app } = env;
  t.after(() => plugin.onunload());
  const { board, a, b, raw, frontmatter } = kanbanFixture(env);
  plugin.openPanel = async () => view;
  await plugin.captureKanbanCardInPanel({ leaf: board, file: a });
  const outside = raw.get(b);
  await view.kanbanQuickSend.onclick();
  assert.equal(frontmatter.get(a).状态, "进行中");
  const before = raw.get(a);
  await view.refreshProviders();
  assert.equal(view.tasks[0].status, "replied");
  assert.match(view.list.querySelector(".bc-task-canvas").textContent, /看板 · Tasks/);
  assert.equal(view.list.querySelector(".bc-answer").textContent, "已核对结果。");
  assert.equal(view.list.querySelector(".bc-patch-cards").children.length, 1);
  assert.match(view.list.querySelector(".bc-patch-cards").innerText, /完成回归/);
  assert.match(view.list.querySelector(".bc-patch").innerText, /更新 1 · 跳过 1/);
  assert.equal(view.list.querySelectorAll(".bc-kanban-quick-status").length, 4);
  const locate = view.list.querySelector(".bc-card-focus");
  app.workspace.revealLeaf = async leaf => assert.equal(leaf, board);
  assert.equal(await locate.onclick(), true);
  const patchButton = () => view.list.querySelector(".bc-patch-buttons").querySelector("button");
  assert.equal(patchButton().textContent, "应用到看板");
  await patchButton().onclick();
  assert.equal(frontmatter.get(a).状态, "已完成");
  assert.match(raw.get(a), /priority: 2/);
  assert.match(raw.get(a), /- \[x\] 验证结果/);
  assert.match(raw.get(a), /- 完成回归\n关联：/);
  assert.equal(raw.get(b), outside);
  assert.equal(patchButton().textContent, "撤销应用");
  const applied = raw.get(a);
  raw.set(a, applied + "后续人工修改\n");
  await patchButton().onclick();
  assert.match(raw.get(a), /后续人工修改/);
  assert.equal(patchButton().textContent, "撤销应用");
  raw.set(a, applied);
  await patchButton().onclick();
  assert.equal(raw.get(a), before);
  assert.equal(patchButton().textContent, "应用到看板");
});

test("queues an HTTP Canvas task with no Bridge configuration, renders the reply, and applies and reverts the patch", async t => {
  let resolveRequest;
  const requests = [];
  const { plugin, createView, app, leaves, saved } = setup({
    realModules: true,
    settings: { openaiProviders: [{ id: "local-api", name: "Local API", enabled: true, models: "one,two", defaultModel: "two" }] },
    requestUrl: request => { requests.push(request); return new Promise(resolve => { resolveRequest = resolve; }); },
    render: (_app, text, el) => { el.createEl("h1", { text: text.replace(/^# /, "") }); },
  });
  const file = { path: "Draft.canvas", extension: "canvas" };
  const selected = { id: "chosen" };
  let liveData = { nodes: [card("chosen", { text: "Before" }), card("outside", { text: "Outside" })], edges: [] };
  let focused;
  let saves = 0;
  leaves.push(leaf(file, {
    selection: new Set([selected]), nodes: new Map([[selected.id, selected]]), getData: () => liveData,
    selectOnly: node => { focused = node; }, importData: data => { liveData = data; }, requestSave: () => { saves++; },
  }));
  app.vault.getFileByPath = name => name === file.path ? file : null;
  const view = createView();
  t.after(() => view.onClose());
  await view.onOpen();
  assert.equal(view.executor, "local-api");
  assert.deepEqual(Array.from(view.executorButtons, ([id]) => id), ["local-api"]);
  assert.equal(view.indicator.dataset.ready, "true");
  assert.equal(view.modelSelect.value, "two");
  assert.equal(view.feedback.textContent, "");
  assert.equal(await view.captureSelection(), true);
  assert.equal(view.effortWrap.hidden, true);
  assert.equal(view.repoRow.hidden, true);
  assert.deepEqual(Array.from(view.modeButtons, ([id]) => id), ["edit_canvas"]);
  view.input.value = "Make the selected note clearer";
  view.input.oninput();
  await view.send();
  assert.equal(view.input.value, "");
  assert.equal(view.list.querySelector(".bc-task").dataset.status, "running");
  assert.equal(requests[0].throw, false);
  const body = JSON.parse(requests[0].body);
  assert.equal(body.model, "two");
  const parsed = canvasContext.parseCanvasPromptEnvelope(body.messages[0].content);
  assert.equal(parsed.instruction, "Make the selected note clearer");
  assert.deepEqual(parsed.metadata.selectedIds, ["chosen"]);
  assert.equal(parsed.metadata.targetWorkspace, "");
  assert.match(body.messages[0].content, /执行者 Local API/);
  const reply = '# Updated note\n\n```canvas-patch\n{"updateNodes":[{"id":"chosen","text":"After"},{"id":"outside","text":"Overwrite"}]}\n```';
  resolveRequest({ status: 200, json: { choices: [{ message: { content: reply } }] } });
  await new Promise(resolve => setImmediate(resolve));
  await view.refresh();
  assert.equal(view.list.querySelector(".bc-task").dataset.status, "replied");
  assert.equal(view.list.querySelector(".bc-meta").querySelector(".bc-badge").textContent, "Local API");
  assert.match(view.list.querySelector(".bc-answer").querySelector("h1").textContent, /Updated note/);
  assert.equal(view.list.querySelector(".bc-card-grid").querySelectorAll(".bc-mini-card").length, 1);
  assert.ok(view.list.querySelector(".bc-patch-cards").querySelector(".bc-mini-card"));
  view.list.querySelector(".bc-card-focus").onclick();
  assert.equal(focused, selected);
  const patchButton = () => view.list.querySelector(".bc-patch-buttons").querySelector("button");
  await patchButton().onclick();
  assert.deepEqual(Array.from(liveData.nodes, node => node.text), ["After", "Outside"]);
  const task = plugin.localTaskStore.list(app.vault.adapter.getBasePath())[0];
  const key = `local-api:${task.id}`;
  assert.ok(saved.get("obsidian-canvas-bridge:applied")[key]);
  assert.equal(patchButton().textContent, "撤销应用");
  await patchButton().onclick();
  assert.deepEqual(Array.from(liveData.nodes, node => node.text), ["Before", "Outside"]);
  assert.equal(Object.hasOwn(plugin.appliedPatches, key), false);
  assert.equal(saves, 2);
});

test("shows setup guidance for a missing Bridge entry and supports custom providers through the extension API", async t => {
  const { plugin, createView } = setup({ realModules: true, bridgeConfig: { mcpServers: {} } });
  const view = createView();
  t.after(() => view.onClose());
  await view.onOpen();
  assert.match(view.feedback.textContent, /设置 → Canvas Bridge/);
  assert.equal(view.executorButtons.length, 0);
  assert.equal(view.submit.disabled, true);

  const tasks = [];
  let stopped = 0;
  let change;
  let request;
  const custom = {
    id: "reviewer", label: "Review Provider", kind: "custom",
    capabilities: { modes: ["execute_task"], supportsRepo: true, supportsEffort: true },
    getStatus: async () => ({ available: true, models: ["model-a"], efforts: ["low", "high"] }),
    listTasks: () => tasks,
    subscribe: (_workspace, notify) => { change = notify; return () => { stopped++; }; },
    dispatch: input => {
      request = input;
      tasks.push({ id: "result", status: "running", prompt: input.prompt, time: new Date().toISOString() });
      return { ok: true, id: "result" };
    },
  };
  assert.equal(plugin.registerProvider(custom), custom);
  await view.refresh();
  assert.deepEqual(Array.from(view.executorButtons, ([id]) => id), ["reviewer"]);
  assert.equal(view.executor, "reviewer");
  assert.equal(view.effortWrap.hidden, false);
  view.effortSelect.value = "high";
  view.onEffortChange();
  view.input.value = "Review this";
  view.input.oninput();
  await view.send();
  assert.equal(request.prompt, "Review this");
  assert.equal(request.mode, "execute_task");
  assert.equal(request.model, "model-a");
  assert.equal(request.effort, "high");
  assert.equal(request.workspace, view.workspacePath);
  assert.ok(request.token);
  tasks[0] = { ...tasks[0], status: "replied", reply: "Looks good", providerLabel: "Review Worker" };
  change();
  await view.refresh();
  assert.equal(view.list.querySelector(".bc-meta").querySelector(".bc-badge").textContent, "Review Worker");
  assert.equal(view.list.querySelector(".bc-answer").textContent, "Looks good");
  await plugin.updateSettings({ enableBridge: false, openaiProviders: [] });
  assert.equal(plugin.getProviders().includes(custom), true);
  assert.equal(plugin.providerLabel("reviewer"), "Review Provider");
  assert.equal(plugin.unregisterProvider("reviewer"), true);
  await view.refresh();
  assert.equal(stopped, 1);
  assert.match(view.feedback.textContent, /设置 → Canvas Bridge/);
});

test("settings tab edits profiles, tests the current endpoint, and refreshes an open sidebar", async t => {
  class PluginSettingTab { constructor() { this.containerEl = new FakeElement(); } }
  class Setting {
    constructor(parent) {
      this.el = parent.createDiv({ cls: "setting-item" });
      this.el.setting = this;
    }
    setName(name) { this.name = name; return this; }
    setDesc(desc) { this.desc = desc; return this; }
    setHeading() { return this; }
    addControl(build) {
      this.control = {
        inputEl: new FakeElement("input"),
        setValue(value) { this.value = value; return this; },
        setButtonText(value) { this.text = value; return this; },
        onChange(change) { this.change = change; return this; },
        onClick(click) { this.click = click; return this; },
      };
      build(this.control);
      return this;
    }
    addText(build) { return this.addControl(build); }
    addTextArea(build) { return this.addControl(build); }
    addToggle(build) { return this.addControl(build); }
    addButton(build) { return this.addControl(build); }
  }
  const requests = [];
  const { plugin, createView, notices, writes, saved } = setup({
    realModules: true, obsidian: { PluginSettingTab, Setting },
    requestUrl: options => { requests.push(options); return { status: 200, json: { data: [] } }; },
  });
  const view = createView();
  t.after(() => view.onClose());
  await view.onOpen();
  const tab = plugin.registeredSettingsTab;
  tab.display();
  const cardAt = index => tab.containerEl.querySelectorAll(".bc-settings-card")[index];
  const setting = (name, container = tab.containerEl) => container.querySelectorAll(".setting-item")
    .map(item => item.setting).find(item => item.name === name);
  assert.match(setting("启用本机桥接").desc, /未检测到/);
  await setting("OpenAI 兼容服务").control.click();
  assert.equal(tab.containerEl.querySelectorAll(".bc-settings-card").length, 2);
  const newCard = cardAt(1);
  assert.equal(setting("API Key", newCard).control.inputEl.type, "password");
  await Promise.all([
    setting("名称", newCard).control.change("Example Endpoint"),
    setting("Base URL", newCard).control.change("https://api.example.test/v1/chat/completions/"),
    setting("API Key", newCard).control.change("example-test-key"),
    setting("模型", newCard).control.change("demo-a,demo-b\ndemo-a"),
    setting("系统提示词（可选）", newCard).control.change("Be concise."),
    setting("启用服务", newCard).control.change(true),
  ]);
  await view.refresh();
  const profile = writes.at(-1).openaiProviders[1];
  assert.equal(profile.name, "Example Endpoint");
  assert.equal(profile.apiKey, "example-test-key");
  assert.equal(profile.systemPrompt, "Be concise.");
  assert.deepEqual(profile.models, ["demo-a", "demo-b"]);
  assert.equal(profile.defaultModel, "demo-a");
  assert.equal(view.executor, profile.id);
  assert.equal(view.modelSelect.value, "demo-a");
  assert.equal(JSON.stringify(plugin.getProviders()).includes(profile.apiKey), false);
  assert.equal(JSON.stringify(Array.from(saved)).includes(profile.apiKey), false);
  const [check, remove] = newCard.querySelectorAll("button");
  await check.onclick({ currentTarget: check });
  assert.equal(requests[0].url, "https://api.example.test/v1/models");
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].headers.Authorization, "Bearer example-test-key");
  assert.match(notices.at(-1), /连接成功/);
  await setting("启用本机桥接").control.change(false);
  assert.equal(writes.at(-1).enableBridge, false);
  assert.equal(setting("启用本机桥接").desc, "已停用");
  await remove.onclick();
  await view.refresh();
  assert.equal(writes.at(-1).openaiProviders.length, 1);
  assert.equal(tab.containerEl.querySelectorAll(".bc-settings-card").length, 1);
  assert.equal(view.executorButtons.length, 0);
});

test("keeps detected Bridge adapters and the watcher working and merges provider history with a cap", async t => {
  const calls = [];
  let closed = 0;
  const bridgeTasks = [{ id: "shared", executor: "codex", status: "replied", prompt: "Bridge task", time: "2026-06-03T00:00:00Z" }];
  const { plugin, createView } = setup({
    realModules: true,
    bridgeConfig: { mcpServers: { "chatgpt-bridge": { command: path.resolve("python"), args: [path.resolve("bridge_server.py")] } } },
    watch: () => ({ on() {}, close() { closed++; } }),
    execFile: (_command, _args, _options, callback) => ({ stdin: {
      on() {}, end(text) {
        const payload = JSON.parse(text);
        calls.push(payload);
        const body = payload.action === "snapshot" ? { paired: true, project: "example", conversation: "chat", codex_ready: true, tasks: bridgeTasks } : {};
        queueMicrotask(() => callback(null, JSON.stringify({ ok: true, ...body })));
      },
    } }),
  });
  await plugin.settingsReady;
  plugin.registerProvider({
    id: "reviewer", label: "Reviewer", kind: "custom", capabilities: { modes: ["execute_task"] },
    getStatus: () => ({ ready: true }), dispatch: () => ({ ok: false }),
    listTasks: () => [
      { id: "shared", status: "replied", prompt: "External task", time: "2026-06-02T00:00:00Z" },
      ...Array.from({ length: 30 }, (_, i) => ({ id: `task-${i}`, status: "blocked", prompt: "Old task", time: new Date(i * 1000).toISOString() })),
    ],
  });
  const view = createView();
  t.after(() => view.onClose());
  await view.onOpen();
  assert.deepEqual(Array.from(view.executorButtons, ([id]) => id), ["agy", "codex", "reviewer"]);
  assert.equal(view.executor, "agy");
  assert.equal(view.count.textContent, "30");
  assert.deepEqual(Array.from(view.tasks.slice(0, 2), task => task.prompt), ["Bridge task", "External task"]);
  assert.deepEqual(view.list.querySelectorAll(".bc-task").slice(0, 2).map(el => el.dataset.taskKey), ["codex:shared", "reviewer:shared"]);
  view.setExecutor("codex");
  view.input.value = "Bridge request";
  view.input.oninput();
  await view.send();
  const sent = calls.find(call => call.action === "dispatch_codex");
  assert.equal(sent.text, "Bridge request");
  assert.equal(sent.mode, "execute_task");
  assert.ok(sent.token);
  await plugin.updateSettings({ enableBridge: false });
  await view.refresh();
  assert.equal(closed, 1);
  assert.equal(view.executor, "reviewer");
  assert.deepEqual(Array.from(view.executorButtons, ([id]) => id), ["reviewer"]);
});

test("uses global fetch when Obsidian requestUrl is unavailable", async () => {
  const requests = [];
  const { plugin } = setup({
    realModules: true,
    settings: { enableBridge: false, openaiProviders: [{ id: "sample-api", enabled: true, baseUrl: "http://localhost:12345/v1" }] },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ choices: [{ message: { content: "Hello from fetch" } }] }));
    },
  });
  await plugin.settingsReady;
  const task = await plugin.providers.get("sample-api").dispatch({ workspace: "example", prompt: "Hello" }).settled;
  assert.equal(task.reply, "Hello from fetch");
  assert.equal(requests[0].url, "http://localhost:12345/v1/chat/completions");
  assert.equal(Object.hasOwn(requests[0].options.headers, "Authorization"), false);
});
