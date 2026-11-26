const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const canvasContext = require("../canvas_context.js");
const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

class FakeElement {
  constructor(tag = "div", options = {}) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.attributes = {};
    this.style = { setProperty: (name, value) => { this.style[name] = value; } };
    const classes = new Set((options.cls || "").split(/\s+/).filter(Boolean));
    this.classList = { remove: name => classes.delete(name), contains: name => classes.has(name) };
    this.textContent = options.text || "";
    this.open = false;
    this.listeners = new Map();
    if (options.attr) for (const [name, value] of Object.entries(options.attr)) this.setAttribute(name, value);
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setText(text) { this.textContent = String(text ?? ""); this.children = []; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  createEl(tag, options = {}) { return this.appendChild(new FakeElement(tag, options)); }
  createDiv(options = {}) { return this.createEl("div", options); }
  createSpan(options = {}) { return this.createEl("span", options); }
  empty() { this.children = []; this.textContent = ""; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
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
  get innerText() { return [this.textContent, ...this.children.map(child => child.innerText)].filter(Boolean).join(""); }
}

function setup(options = {}) {
  const module = { exports: {} };
  const viewTypes = new Map();
  const events = new Map();
  const leaves = [];
  const commands = [];
  const saved = new Map();
  const app = {
    workspace: {
      getLeavesOfType: type => leaves.filter(leaf => leaf.view.getViewType() === type),
      getMostRecentLeaf: () => null,
      on: (name, handler) => events.set(name, handler),
    },
    vault: {},
    loadLocalStorage: key => saved.get(key),
    saveLocalStorage: (key, value) => saved.set(key, value),
  };
  class Plugin {
    constructor() { this.app = app; }
    registerView(type, create) { viewTypes.set(type, create); }
    addRibbonIcon() {}
    addCommand(command) { commands.push(command.id); }
    registerEvent() {}
  }
  class ItemView {
    constructor() { this.app = app; this.children = []; }
    addChild(child) { this.children.push(child); return child; }
    removeChild(child) { this.children = this.children.filter(item => item !== child); child.unload?.(); }
  }
  class Scope { register() {} }
  class Component { constructor() { this.unloaded = false; } unload() { this.unloaded = true; } }
  const obsidian = { Plugin, ItemView, Scope, setIcon() {} };
  if (options.render) {
    obsidian.Component = Component;
    obsidian.MarkdownRenderer = { render: options.render };
  }
  vm.runInNewContext(main, {
    module,
    window: { setTimeout, clearTimeout, setInterval, clearInterval },
    require: name => name === "obsidian" ? obsidian : require(name),
  });
  const plugin = new module.exports();
  plugin.canvasContext = canvasContext;
  plugin.onload();
  return {
    plugin, app, events, leaves, commands, saved,
    createView: () => viewTypes.get("obsidian-canvas-bridge")({}),
  };
}

function leaf(file, canvas, fallback) {
  return { view: { getViewType: () => "canvas", file, canvas, getViewData: fallback } };
}

function card(id, fields = {}) {
  return { id, type: "text", x: 0, y: 0, width: 100, height: 50, ...fields };
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
