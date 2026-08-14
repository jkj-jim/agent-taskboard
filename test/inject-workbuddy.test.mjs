import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const sourceUrl = new URL("../inject/workbuddy-taskboard.user.js", import.meta.url);
const source = await readFile(sourceUrl, "utf8");

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const ENTRY_SELECTOR = "#workbuddy-taskboard-entry";
const PANEL_SELECTOR = "#workbuddy-taskboard-panel";
const FRAME_SELECTOR = "#workbuddy-taskboard-frame";
const SIDEBAR_TAB_LABELS = [
  "新建任务",
  "助理",
  "项目",
  "专家·技能·连接器",
  "自动化",
  "资料库",
  "更多应用·灵感",
];
const MODE_TAB_LABELS = ["日常办公", "代码开发", "设计创意"];

// WorkBuddy 的注入脚本只依赖一小部分 DOM API，这里用最小 DOM 桩在 node --test 里跑，
// 与仓库其它注入测试一样不引入新依赖（本机没有 jsdom / Chromium 也能全绿）。
function matchesCompound(element, compound) {
  const tokens = compound.match(/\[[^\]]+\]|\.[-\w]+|#[-\w]+|[a-zA-Z][-\w]*|\*/g) || [];
  return tokens.length > 0 && tokens.every((token) => {
    if (token === "*") return true;
    if (token.startsWith(".")) return element.classList.contains(token.slice(1));
    if (token.startsWith("#")) return element.id === token.slice(1);
    if (token.startsWith("[")) {
      const body = token.slice(1, -1);
      const separator = body.indexOf("=");
      if (separator === -1) return element.hasAttribute(body.trim());
      const name = body.slice(0, separator).trim();
      const value = body.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
      return element.getAttribute(name) === value;
    }
    return element.localName === token.toLowerCase();
  });
}

function matchesSelector(element, selector) {
  return String(selector)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => matchesCompound(element, part));
}

class StubNode {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
    this.listeners = new Map();
  }

  get parentElement() {
    return this.parentNode?.nodeType === 1 ? this.parentNode : null;
  }

  get nextSibling() {
    const siblings = this.parentNode?.childNodes || [];
    return siblings[siblings.indexOf(this) + 1] || null;
  }

  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.ownerDocument;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  addEventListener(type, listener, options) {
    const capture = options === true || options?.capture === true;
    const registered = this.listeners.get(type) || [];
    registered.push({ listener, capture });
    this.listeners.set(type, registered);
  }

  removeEventListener(type, listener, options) {
    const capture = options === true || options?.capture === true;
    const registered = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      registered.filter((entry) => entry.listener !== listener || entry.capture !== capture),
    );
  }
}

class StubText extends StubNode {
  constructor(ownerDocument, data) {
    super(ownerDocument);
    this.nodeType = 3;
    this.data = String(data);
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = String(value);
  }
}

class StubElement extends StubNode {
  constructor(ownerDocument, localName, namespaceURI) {
    super(ownerDocument);
    this.nodeType = 1;
    this.localName = String(localName).toLowerCase();
    this.namespaceURI = namespaceURI || HTML_NAMESPACE;
    this.tagName = this.namespaceURI === SVG_NAMESPACE ? this.localName : this.localName.toUpperCase();
    this.attributes = new Map();
    this.style = {};
    this.rect = { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 };
  }

  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }

  get id() {
    return this.getAttribute("id") || "";
  }

  set id(value) {
    this.setAttribute("id", value);
  }

  get src() {
    return this.getAttribute("src") || "";
  }

  set src(value) {
    this.setAttribute("src", value);
  }

  get hidden() {
    return this.hasAttribute("hidden");
  }

  set hidden(value) {
    if (value) this.setAttribute("hidden", "");
    else this.removeAttribute("hidden");
  }

  get classList() {
    const element = this;
    const tokens = () => (element.getAttribute("class") || "").split(/\s+/).filter(Boolean);
    const write = (list) => element.setAttribute("class", list.join(" "));
    return {
      contains: (token) => tokens().includes(token),
      add: (token) => {
        const list = tokens();
        if (!list.includes(token)) write([...list, token]);
      },
      remove: (token) => write(tokens().filter((item) => item !== token)),
    };
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join("");
  }

  set textContent(value) {
    for (const node of [...this.childNodes]) node.parentNode = null;
    this.childNodes = [];
    if (String(value) !== "") this.appendChild(this.ownerDocument.createTextNode(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  getAttributeNames() {
    return [...this.attributes.keys()];
  }

  appendChild(node) {
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  insertBefore(node, reference) {
    if (!reference) return this.appendChild(node);
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(reference), 0, node);
    return node;
  }

  replaceChild(next, previous) {
    const index = this.childNodes.indexOf(previous);
    if (index === -1) throw new Error("replaceChild: node not found");
    next.parentNode?.removeChild(next);
    next.parentNode = this;
    previous.parentNode = null;
    this.childNodes.splice(index, 1, next);
    return previous;
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index === -1) return node;
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  cloneNode(deep) {
    const copy = new StubElement(this.ownerDocument, this.localName, this.namespaceURI);
    for (const [name, value] of this.attributes) copy.attributes.set(name, value);
    Object.assign(copy.style, this.style);
    copy.rect = { ...this.rect };
    if (deep) {
      for (const node of this.childNodes) {
        copy.appendChild(node.nodeType === 1
          ? node.cloneNode(true)
          : this.ownerDocument.createTextNode(node.data));
      }
    }
    return copy;
  }

  descendants() {
    const found = [];
    for (const node of this.childNodes) {
      if (node.nodeType !== 1) continue;
      found.push(node, ...node.descendants());
    }
    return found;
  }

  querySelectorAll(selector) {
    return this.descendants().filter((node) => matchesSelector(node, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }

  closest(selector) {
    let node = this;
    while (node?.nodeType === 1) {
      if (matchesSelector(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  getBoundingClientRect() {
    return { ...this.rect };
  }
}

class StubDocument extends StubNode {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.nodeType = 9;
    this.documentElement = this.createElement("html");
    this.head = this.createElement("head");
    this.body = this.createElement("body");
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  appendChild(node) {
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index !== -1) this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  createElement(localName) {
    return new StubElement(this, localName, HTML_NAMESPACE);
  }

  createElementNS(namespaceURI, localName) {
    return new StubElement(this, localName, namespaceURI);
  }

  createTextNode(data) {
    return new StubText(this, data);
  }

  querySelectorAll(selector) {
    const roots = [this.documentElement, ...this.documentElement.descendants()];
    return roots.filter((node) => matchesSelector(node, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  getElementById(id) {
    return this.querySelector(`#${id}`);
  }
}

function buildTab(document, label, { selected = false, trackId = "" } = {}) {
  const tab = document.createElement("div");
  tab.setAttribute("role", "tab");
  tab.classList.add("sidebar-tab-item");
  tab.setAttribute("aria-selected", selected ? "true" : "false");
  if (selected) tab.classList.add("active");
  if (trackId) tab.setAttribute("data-track-id", trackId);
  const icon = document.createElementNS(SVG_NAMESPACE, "svg");
  icon.setAttribute("class", "sidebar-tab-icon");
  const glyph = document.createElementNS(SVG_NAMESPACE, "path");
  glyph.setAttribute("d", "M2 2h12v12H2z");
  icon.appendChild(glyph);
  const text = document.createElement("span");
  text.classList.add("sidebar-tab-label");
  text.textContent = label;
  tab.appendChild(icon);
  tab.appendChild(text);
  return tab;
}

function createHarness({
  sidebar = true,
  navTabLabels = SIDEBAR_TAB_LABELS,
  selectedLabel = "助理",
  modeTabsInSidebar = false,
  sidebarRight = 268,
  config,
} = {}) {
  const document = new StubDocument();
  const shell = document.createElement("div");
  shell.classList.add("app-shell");
  document.body.appendChild(shell);

  const sidebarFrame = document.createElement("div");
  sidebarFrame.classList.add("sidebar-grid-item");
  sidebarFrame.rect = { top: 0, left: 0, right: sidebarRight, bottom: 900, width: sidebarRight, height: 900 };
  shell.appendChild(sidebarFrame);

  let sidebarView = null;
  let navGroup = null;
  let conversationRow = null;
  const navTabs = new Map();
  if (sidebar) {
    sidebarView = document.createElement("div");
    sidebarView.classList.add("conversation-sidebar");
    sidebarView.setAttribute("data-view-id", "sidebar");
    sidebarFrame.appendChild(sidebarView);

    navGroup = document.createElement("div");
    navGroup.classList.add("sidebar-tab-strip");
    sidebarView.appendChild(navGroup);
    for (const label of navTabLabels) {
      const tab = buildTab(document, label, {
        selected: label === selectedLabel,
        trackId: label === "新建任务" ? "agent_new_task_button_clicked" : "",
      });
      navGroup.appendChild(tab);
      navTabs.set(label, tab);
    }

    const scroller = document.createElement("div");
    scroller.setAttribute("data-testid", "virtuoso-scroller");
    sidebarView.appendChild(scroller);
    conversationRow = document.createElement("div");
    conversationRow.setAttribute("data-conversation-id", "0f0f6f2e-1111-4222-8333-444455556666");
    conversationRow.textContent = "上一轮会话";
    scroller.appendChild(conversationRow);
  }

  const mainContent = document.createElement("div");
  mainContent.setAttribute("data-view-id", "main-content");
  shell.appendChild(mainContent);
  const modeStrip = document.createElement("div");
  modeStrip.classList.add("mode-tab-strip");
  (modeTabsInSidebar && sidebarView ? sidebarView : mainContent).appendChild(modeStrip);
  const modeTabs = new Map();
  for (const label of MODE_TAB_LABELS) {
    const tab = buildTab(document, label, { selected: label === "日常办公" });
    modeStrip.appendChild(tab);
    modeTabs.set(label, tab);
  }

  const resizeObservers = [];
  class ResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      this.disconnected = false;
      resizeObservers.push(this);
    }

    observe(target) {
      this.targets.push(target);
    }

    disconnect() {
      this.disconnected = true;
      this.targets = [];
    }
  }

  const sandbox = { document, URL, ResizeObserver, innerWidth: 1440, innerHeight: 900 };
  sandbox.listeners = new Map();
  sandbox.addEventListener = StubNode.prototype.addEventListener.bind(sandbox);
  sandbox.removeEventListener = StubNode.prototype.removeEventListener.bind(sandbox);
  sandbox.window = sandbox;
  if (config !== undefined) sandbox.__workbuddyTaskboardConfig = config;
  vm.createContext(sandbox);

  const fireClick = (target) => {
    const event = {
      type: "click",
      target,
      defaultPrevented: false,
      stopped: false,
      preventDefault() {
        event.defaultPrevented = true;
      },
      stopPropagation() {
        event.stopped = true;
      },
    };
    const path = [];
    let node = target;
    while (node) {
      path.push(node);
      node = node.parentNode;
    }
    for (const current of [...path].reverse()) {
      for (const entry of current.listeners?.get("click") || []) {
        if (entry.capture) entry.listener(event);
      }
      if (event.stopped) return event;
    }
    for (const current of path) {
      for (const entry of current.listeners?.get("click") || []) {
        if (!entry.capture) entry.listener(event);
      }
      if (event.stopped) return event;
    }
    return event;
  };

  return {
    document,
    sandbox,
    resizeObservers,
    sidebarFrame,
    sidebarView,
    navGroup,
    navTabs,
    modeStrip,
    modeTabs,
    conversationRow,
    fireClick,
    run: () => vm.runInContext(source, sandbox, { filename: "workbuddy-taskboard.user.js" }),
    entry: () => document.querySelector(ENTRY_SELECTOR),
    panel: () => document.querySelector(PANEL_SELECTOR),
    frame: () => document.querySelector(FRAME_SELECTOR),
    api: () => sandbox.__workbuddyTaskboard,
    documentClickListeners: () => (document.listeners.get("click") || []).length,
    windowResizeListeners: () => (sandbox.listeners.get("resize") || []).length,
  };
}

function runExpectingFailure(harness) {
  try {
    harness.run();
  } catch (error) {
    return error;
  }
  return null;
}

test("面板节点全部走 DOM API 构造，端口与项目来自注入配置", () => {
  assert.match(source, /^\(\(\) => \{/);
  assert.doesNotMatch(source, /innerHTML/);
  assert.doesNotMatch(source, /insertAdjacentHTML|outerHTML|document\.write/);
  assert.match(source, /document\.createElementNS\(SVG_NAMESPACE, "svg"\)/);
  assert.match(source, /const CONFIG_KEY = "__workbuddyTaskboardConfig"/);
  assert.match(source, /const DEFAULT_ORIGIN = "http:\/\/127\.0\.0\.1:47823"/);
  assert.doesNotMatch(source, /DEFAULT_PROJECT/);
  assert.match(source, /const DEFAULT_HOST = "workbuddy"/);
  assert.match(source, /globalThis\[CONFIG_KEY\]/);
  assert.doesNotMatch(source, /http:\/\/127\.0\.0\.1:47823\/\?/);
});

test("锚点齐备时克隆侧边栏导航项做入口，并挂载指向注入地址的面板", () => {
  const harness = createHarness({
    config: { origin: "http://127.0.0.1:51999", project: "agent-taskboard", host: "workbuddy" },
  });
  harness.run();

  const entry = harness.entry();
  const panel = harness.panel();
  const frame = harness.frame();
  assert.ok(entry, "入口必须存在");
  assert.equal(entry.parentElement, harness.navGroup, "入口必须落在侧边栏导航组里");
  assert.notEqual(entry.parentElement, harness.modeStrip, "入口不能落在模式标签组里");
  assert.equal(entry.getAttribute("role"), "tab");
  assert.equal(entry.getAttribute("aria-label"), "任务面板");
  assert.equal(entry.getAttribute("aria-selected"), "false");
  assert.equal(entry.textContent.trim(), "任务面板");
  assert.equal(entry.getAttribute("data-track-id"), null, "克隆时必须去掉埋点属性");
  assert.ok(entry.classList.contains("sidebar-tab-item"), "入口保留原生 tab 的样式类");

  const icon = entry.querySelector("svg");
  assert.ok(icon, "入口必须带图标");
  assert.equal(icon.namespaceURI, SVG_NAMESPACE);
  assert.deepEqual(icon.children.map((node) => node.localName), ["rect", "path"]);
  assert.equal(icon.getAttribute("class"), "sidebar-tab-icon", "图标继承原生尺寸类");

  assert.ok(panel, "面板必须存在");
  assert.equal(panel.parentElement, harness.document.body);
  assert.equal(panel.hidden, true, "面板初始收起");
  assert.equal(panel.style.position, "fixed");
  assert.equal(frame.getAttribute("src"), "http://127.0.0.1:51999/?project=agent-taskboard&host=workbuddy");

  const api = harness.api();
  assert.deepEqual(Object.keys(api).sort(), ["close", "config", "destroy", "open", "version"]);
  assert.deepEqual({ ...api.config }, {
    origin: "http://127.0.0.1:51999",
    project: "agent-taskboard",
    host: "workbuddy",
    url: "http://127.0.0.1:51999/?project=agent-taskboard&host=workbuddy",
  });
  assert.throws(() => {
    "use strict";
    api.config = { origin: "http://example.com" };
  }, /read only|only a getter|Cannot (set|assign)/);
});

test("缺失或不合法的注入配置回退到默认地址", () => {
  for (const config of [undefined, {}, { origin: "" }, { origin: "javascript:alert(1)" }, "nope"]) {
    const harness = createHarness({ config });
    harness.run();
    assert.equal(
      harness.frame().getAttribute("src"),
      "http://127.0.0.1:47823/?host=workbuddy",
      `config=${JSON.stringify(config)} 必须回退到默认地址`,
    );
    assert.equal(harness.api().config.origin, "http://127.0.0.1:47823");
  }

  const partial = createHarness({ config: { origin: "http://127.0.0.1:8080" } });
  partial.run();
  assert.equal(
    partial.frame().getAttribute("src"),
    "http://127.0.0.1:8080/?host=workbuddy",
  );
});

test("锚点缺失时抛出带诊断信息的错误，不静默降级", () => {
  const missingSidebar = createHarness({ sidebar: false });
  const sidebarError = runExpectingFailure(missingSidebar);
  assert.ok(sidebarError, "缺少侧边栏必须抛错");
  assert.match(sidebarError.message, /\[workbuddy-taskboard\] 找不到 WorkBuddy 侧边栏注入锚点/);
  assert.match(sidebarError.message, /sidebarSelectorsTried=\[".conversation-sidebar"/);
  assert.equal(sidebarError.name, "WorkbuddyTaskboardInjectionError");
  assert.equal(sidebarError.detail.sidebarSelector, "");
  assert.equal(sidebarError.detail.sidebarTabCount, 0);
  assert.equal(missingSidebar.entry(), null);
  assert.equal(missingSidebar.panel(), null);
  assert.equal(missingSidebar.api(), undefined);
  assert.match(missingSidebar.sandbox.__workbuddyTaskboardError.message, /找不到 WorkBuddy 侧边栏注入锚点/);

  const modeTabsOnly = createHarness({ navTabLabels: [], modeTabsInSidebar: true });
  const modeError = runExpectingFailure(modeTabsOnly);
  assert.ok(modeError, "只有模式标签时必须抛错而不是克隆模式标签");
  assert.equal(modeError.detail.sidebarTabCount, 3);
  assert.equal(modeError.detail.navTabCount, 0);
  assert.equal(modeTabsOnly.entry(), null);

  const singleTab = createHarness({ navTabLabels: ["资料库"], selectedLabel: "" });
  const singleError = runExpectingFailure(singleTab);
  assert.ok(singleError, "无法判定导航组时必须抛错");
  assert.equal(singleError.detail.navTabCount, 1);
  assert.deepEqual([...singleError.detail.navTabLabels], ["资料库"]);
});

test("重复注入先销毁旧实例，入口和面板都不会重复", () => {
  const harness = createHarness({ config: { origin: "http://127.0.0.1:47823" } });
  harness.run();
  const firstEntry = harness.entry();
  const firstApi = harness.api();
  harness.sandbox.__workbuddyTaskboardConfig = { origin: "http://127.0.0.1:47999", project: "next" };
  harness.run();

  assert.equal(harness.document.querySelectorAll(ENTRY_SELECTOR).length, 1);
  assert.equal(harness.document.querySelectorAll(PANEL_SELECTOR).length, 1);
  assert.equal(harness.document.querySelectorAll(FRAME_SELECTOR).length, 1);
  assert.equal(harness.document.querySelectorAll('[data-workbuddy-taskboard-owned="true"]').length, 3);
  assert.notEqual(harness.entry(), firstEntry, "旧入口必须被替换");
  assert.equal(firstEntry.isConnected, false);
  assert.notEqual(harness.api(), firstApi);
  assert.equal(harness.frame().getAttribute("src"), "http://127.0.0.1:47999/?project=next&host=workbuddy");
  assert.equal(harness.documentClickListeners(), 1, "重复注入不能累积 click 监听");
  assert.equal(harness.windowResizeListeners(), 1, "重复注入不能累积 resize 监听");
  assert.equal(harness.resizeObservers.filter((observer) => !observer.disconnected).length, 1);
});

test("点入口开面板，点侧边栏其他项收面板并还原原生选中", () => {
  const harness = createHarness();
  harness.run();
  const entry = harness.entry();
  const panel = harness.panel();
  const assistant = harness.navTabs.get("助理");

  const openEvent = harness.fireClick(entry.querySelector("span"));
  assert.equal(openEvent.defaultPrevented, true, "入口点击必须拦下原生 tab 行为");
  assert.equal(openEvent.stopped, true);
  assert.equal(panel.hidden, false);
  assert.equal(panel.style.display, "block");
  assert.equal(entry.getAttribute("aria-selected"), "true");
  assert.equal(assistant.getAttribute("aria-selected"), "false", "打开时让出原生选中态");
  assert.equal(assistant.classList.contains("active"), false);

  harness.fireClick(harness.frame());
  assert.equal(panel.hidden, false, "点面板自身不收起");

  harness.fireClick(harness.navTabs.get("项目").querySelector("span"));
  assert.equal(panel.hidden, true);
  assert.equal(panel.style.display, "none");
  assert.equal(entry.getAttribute("aria-selected"), "false");
  assert.equal(assistant.getAttribute("aria-selected"), "true", "收起时还原原生选中态");
  assert.equal(assistant.classList.contains("active"), true);

  harness.fireClick(entry);
  assert.equal(panel.hidden, false);
  harness.fireClick(harness.conversationRow);
  assert.equal(panel.hidden, true, "点会话列表同样收起面板");

  harness.api().open();
  assert.equal(panel.hidden, false);
  harness.api().close();
  assert.equal(panel.hidden, true);
});

test("收起面板时按原样还原原生 tab，不塞入宿主没用过的 class", () => {
  const harness = createHarness();
  harness.run();
  const assistant = harness.navTabs.get("助理");
  assistant.classList.remove("active");
  const api = harness.api();

  api.open();
  assert.equal(assistant.getAttribute("aria-selected"), "false");
  api.close();
  assert.equal(assistant.getAttribute("aria-selected"), "true");
  assert.equal(assistant.classList.contains("active"), false);
});

test("面板跟随侧边栏宽度定位", () => {
  const harness = createHarness({ sidebarRight: 268 });
  harness.run();
  const panel = harness.panel();
  assert.equal(panel.style.left, "268px");

  harness.sidebarFrame.rect = { ...harness.sidebarFrame.rect, right: 412, width: 412 };
  const observer = harness.resizeObservers.at(-1);
  assert.deepEqual(observer.targets, [harness.sidebarFrame], "ResizeObserver 必须盯住侧边栏容器");
  observer.callback([{ target: harness.sidebarFrame }]);
  assert.equal(panel.style.left, "412px");

  harness.sidebarFrame.rect = { ...harness.sidebarFrame.rect, right: 96, width: 96 };
  for (const entry of harness.sandbox.listeners.get("resize")) entry.listener({ type: "resize" });
  assert.equal(panel.style.left, "96px");
});

test("destroy 清理入口、面板、监听器和 ResizeObserver", () => {
  const harness = createHarness();
  harness.run();
  const api = harness.api();
  const assistant = harness.navTabs.get("助理");
  api.open();

  api.destroy();
  assert.equal(harness.entry(), null);
  assert.equal(harness.panel(), null);
  assert.equal(harness.frame(), null);
  assert.equal(harness.document.querySelectorAll('[data-workbuddy-taskboard-owned="true"]').length, 0);
  assert.equal(harness.documentClickListeners(), 0);
  assert.equal(harness.windowResizeListeners(), 0);
  assert.equal(harness.resizeObservers.every((observer) => observer.disconnected), true);
  assert.equal(harness.sandbox.__workbuddyTaskboard, undefined);
  assert.equal(assistant.getAttribute("aria-selected"), "true", "销毁时还原原生选中态");

  api.destroy();
  api.open();
  api.close();
  assert.equal(harness.panel(), null, "销毁后调用 API 不再重建节点");

  harness.fireClick(harness.navTabs.get("项目"));
  assert.equal(harness.documentClickListeners(), 0, "销毁后不再拦截宿主点击");
});
