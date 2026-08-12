(() => {
  "use strict";

  const VERSION = "0.1.0";
  const SENTINEL_KEY = "__workbuddyTaskboard";
  const CONFIG_KEY = "__workbuddyTaskboardConfig";
  const ERROR_KEY = "__workbuddyTaskboardError";
  const ENTRY_ID = "workbuddy-taskboard-entry";
  const PANEL_ID = "workbuddy-taskboard-panel";
  const FRAME_ID = "workbuddy-taskboard-frame";
  const OWNED_ATTRIBUTE = "data-workbuddy-taskboard-owned";
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const DEFAULT_ORIGIN = "http://127.0.0.1:47823";
  const DEFAULT_PROJECT = "local";
  const DEFAULT_HOST = "workbuddy";
  const SIDEBAR_SELECTORS = [".conversation-sidebar", '[data-view-id="sidebar"]'];
  const TAB_SELECTOR = '[role="tab"]';
  const MODE_TAB_LABELS = ["日常办公", "代码开发", "设计创意"];
  const EXCLUDED_TEMPLATE_LABELS = ["新建任务"];
  const PREFERRED_TEMPLATE_LABELS = ["资料库", "自动化", "项目", "助理"];
  const ENTRY_LABEL = "任务面板";
  const ENTRY_ORDER = "60";
  const PANEL_Z_INDEX = "2147483000";

  let sidebar = null;
  let sidebarFrame = null;
  let tabStrip = null;
  let entry = null;
  let panel = null;
  let frame = null;
  let resizeObserver = null;
  let restoreTab = null;
  let active = false;
  let destroyed = false;

  function fail(reason, detail) {
    const summary = Object.entries(detail)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(", ");
    const error = new Error(`[workbuddy-taskboard] ${reason}（${summary}）`);
    error.name = "WorkbuddyTaskboardInjectionError";
    error.detail = detail;
    window[ERROR_KEY] = { message: error.message, detail, at: new Date().toISOString() };
    throw error;
  }

  function trimmedString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function normalizedLabel(node) {
    if (!node) return "";
    const text = node.getAttribute?.("aria-label") || node.textContent || "";
    return String(text).replace(/\s+/g, " ").trim();
  }

  function parseHttpUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:" ? url : null;
    } catch (_) {
      return null;
    }
  }

  function resolveConfig() {
    const injected = globalThis[CONFIG_KEY];
    const source = injected && typeof injected === "object" ? injected : {};
    const project = trimmedString(source.project) || DEFAULT_PROJECT;
    const host = trimmedString(source.host) || DEFAULT_HOST;
    const url = parseHttpUrl(trimmedString(source.origin)) || parseHttpUrl(DEFAULT_ORIGIN);
    url.hash = "";
    url.searchParams.set("project", project);
    url.searchParams.set("host", host);
    return Object.freeze({ origin: url.origin, project, host, url: url.href });
  }

  function findSidebar() {
    for (const selector of SIDEBAR_SELECTORS) {
      const node = document.querySelector(selector);
      if (node) return { node, selector };
    }
    return { node: null, selector: "" };
  }

  // 侧边栏导航项和顶部的模式标签共用 [role="tab"]，入口只能克隆导航项：
  // 先按文案剔除模式标签，再取同一父节点下最大的那一组，避免文案单点匹配。
  function findAnchors() {
    const found = findSidebar();
    const sidebarTabs = found.node ? Array.from(found.node.querySelectorAll(TAB_SELECTOR)) : [];
    const navTabs = sidebarTabs.filter((tab) => !MODE_TAB_LABELS.includes(normalizedLabel(tab)));
    const groups = new Map();
    for (const tab of navTabs) {
      const parent = tab.parentElement;
      if (!parent) continue;
      groups.set(parent, [...(groups.get(parent) || []), tab]);
    }
    const [strip, groupTabs] = Array.from(groups.entries())
      .sort((left, right) => right[1].length - left[1].length)
      .find(([, list]) => list.length >= 2) || [null, []];
    const candidates = groupTabs.filter(
      (tab) => !EXCLUDED_TEMPLATE_LABELS.includes(normalizedLabel(tab)),
    );
    const template = PREFERRED_TEMPLATE_LABELS
      .map((label) => candidates.find((tab) => normalizedLabel(tab) === label))
      .find(Boolean) || candidates.at(-1) || null;

    if (!found.node || !strip || !template) {
      fail("找不到 WorkBuddy 侧边栏注入锚点", {
        sidebarSelectorsTried: SIDEBAR_SELECTORS,
        sidebarSelector: found.selector,
        documentTabCount: document.querySelectorAll(TAB_SELECTOR).length,
        sidebarTabCount: sidebarTabs.length,
        navTabCount: navTabs.length,
        navTabLabels: navTabs.map(normalizedLabel).slice(0, 20),
        tabGroupCount: groups.size,
        templateCandidateCount: candidates.length,
      });
    }

    return { sidebar: found.node, strip, template };
  }

  function createIcon(reference) {
    const icon = document.createElementNS(SVG_NAMESPACE, "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.8");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.setAttribute("aria-hidden", "true");
    const inheritedClass = reference?.getAttribute("class");
    if (inheritedClass) icon.setAttribute("class", inheritedClass);
    const board = document.createElementNS(SVG_NAMESPACE, "rect");
    board.setAttribute("x", "3.5");
    board.setAttribute("y", "4");
    board.setAttribute("width", "17");
    board.setAttribute("height", "16");
    board.setAttribute("rx", "2.5");
    const columns = document.createElementNS(SVG_NAMESPACE, "path");
    columns.setAttribute("d", "M9 4v16M14.5 8h2.5M14.5 12h2.5M14.5 16h2.5");
    icon.appendChild(board);
    icon.appendChild(columns);
    return icon;
  }

  function replaceEntryIcon(button) {
    const current = button.querySelector("svg");
    const icon = createIcon(current);
    if (current?.parentNode) current.parentNode.replaceChild(icon, current);
    else button.insertBefore(icon, button.childNodes[0] || null);
  }

  function replaceEntryLabel(button) {
    const leaf = Array.from(button.querySelectorAll("*")).filter((node) => (
      node.children.length === 0 && !node.closest("svg") && normalizedLabel(node)
    )).at(-1);
    if (leaf) {
      leaf.textContent = ENTRY_LABEL;
      return;
    }
    for (const node of Array.from(button.childNodes)) {
      if (node.nodeType === 3) node.remove();
    }
    button.appendChild(document.createTextNode(ENTRY_LABEL));
  }

  function createEntry(template) {
    const button = template.cloneNode(true);
    button.id = ENTRY_ID;
    button.setAttribute(OWNED_ATTRIBUTE, "true");
    button.setAttribute("aria-label", ENTRY_LABEL);
    button.setAttribute("aria-selected", "false");
    button.setAttribute("aria-controls", PANEL_ID);
    button.setAttribute("title", ENTRY_LABEL);
    button.removeAttribute("disabled");
    button.classList.remove("active");
    button.classList.remove("selected");
    for (const name of button.getAttributeNames()) {
      if (name.startsWith("data-track") || name.startsWith("dt-")) button.removeAttribute(name);
      if (name === "data-conversation-id" || name === "data-testid") button.removeAttribute(name);
    }
    for (const node of Array.from(button.querySelectorAll("[id]"))) node.removeAttribute("id");
    for (const node of Array.from(button.querySelectorAll("[data-track-id]"))) {
      node.removeAttribute("data-track-id");
    }
    replaceEntryIcon(button);
    replaceEntryLabel(button);
    button.style.order = ENTRY_ORDER;
    return button;
  }

  function createPanel(config) {
    const section = document.createElement("section");
    section.id = PANEL_ID;
    section.setAttribute(OWNED_ATTRIBUTE, "true");
    section.setAttribute("role", "region");
    section.setAttribute("aria-label", ENTRY_LABEL);
    section.hidden = true;
    Object.assign(section.style, {
      position: "fixed",
      top: "0",
      right: "0",
      bottom: "0",
      left: "0",
      display: "none",
      zIndex: PANEL_Z_INDEX,
      overflow: "hidden",
      background: "#fff",
      borderLeft: "1px solid rgba(0, 0, 0, 0.08)",
    });

    const view = document.createElement("iframe");
    view.id = FRAME_ID;
    view.setAttribute(OWNED_ATTRIBUTE, "true");
    view.setAttribute("title", ENTRY_LABEL);
    view.src = config.url;
    Object.assign(view.style, {
      display: "block",
      width: "100%",
      height: "100%",
      border: "0",
      background: "#fff",
    });
    section.appendChild(view);
    return { panel: section, frame: view };
  }

  function updateBounds() {
    if (!panel || !sidebarFrame) return;
    const bounds = sidebarFrame.getBoundingClientRect();
    panel.style.left = `${Math.max(0, Math.round(bounds.right))}px`;
  }

  function nativeTabs() {
    return Array.from(tabStrip.querySelectorAll(TAB_SELECTOR)).filter((tab) => tab !== entry);
  }

  function setEntrySelected(selected) {
    entry.setAttribute("aria-selected", selected ? "true" : "false");
    if (selected) entry.classList.add("active");
    else entry.classList.remove("active");
  }

  // 只让出当前选中的那一个原生 tab，并记下它原本的 aria/class，收起时按原样还原。
  function releaseNativeTab() {
    const selected = nativeTabs().find((tab) => (
      tab.getAttribute("aria-selected") === "true" || tab.classList.contains("active")
    ));
    if (!selected) return null;
    const snapshot = {
      tab: selected,
      ariaSelected: selected.getAttribute("aria-selected"),
      activeClass: selected.classList.contains("active"),
    };
    selected.setAttribute("aria-selected", "false");
    selected.classList.remove("active");
    return snapshot;
  }

  function restoreNativeTab() {
    if (!restoreTab?.tab.isConnected) return;
    const { tab, ariaSelected, activeClass } = restoreTab;
    if (ariaSelected === null) tab.removeAttribute("aria-selected");
    else tab.setAttribute("aria-selected", ariaSelected);
    if (activeClass) tab.classList.add("active");
  }

  function open() {
    if (destroyed || active) return;
    restoreTab = releaseNativeTab();
    setEntrySelected(true);
    active = true;
    updateBounds();
    panel.hidden = false;
    panel.style.display = "block";
  }

  function close() {
    if (!active) return;
    active = false;
    panel.hidden = true;
    panel.style.display = "none";
    setEntrySelected(false);
    restoreNativeTab();
    restoreTab = null;
  }

  function onDocumentClick(event) {
    const target = event.target;
    if (typeof target?.closest !== "function") return;
    if (target.closest(`#${ENTRY_ID}`)) {
      event.preventDefault();
      event.stopPropagation();
      if (active) close();
      else open();
      return;
    }
    if (!active) return;
    if (target.closest(`#${PANEL_ID}`)) return;
    if (sidebar.contains(target)) close();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    close();
    resizeObserver?.disconnect();
    resizeObserver = null;
    window.removeEventListener("resize", updateBounds);
    document.removeEventListener("click", onDocumentClick, true);
    const owned = Array.from(document.querySelectorAll(`[${OWNED_ATTRIBUTE}="true"]`));
    entry?.remove();
    panel?.remove();
    for (const node of owned) node.remove();
    entry = null;
    panel = null;
    frame = null;
    sidebar = null;
    sidebarFrame = null;
    tabStrip = null;
    restoreTab = null;
    if (window[SENTINEL_KEY] === api) delete window[SENTINEL_KEY];
  }

  try {
    window[SENTINEL_KEY]?.destroy?.();
  } catch (_) {}
  document.getElementById(ENTRY_ID)?.remove();
  document.getElementById(PANEL_ID)?.remove();
  for (const node of Array.from(document.querySelectorAll(`[${OWNED_ATTRIBUTE}="true"]`))) {
    node.remove();
  }
  delete window[ERROR_KEY];

  const config = resolveConfig();
  const anchors = findAnchors();
  sidebar = anchors.sidebar;
  sidebarFrame = sidebar.parentElement || sidebar;
  tabStrip = anchors.strip;
  entry = createEntry(anchors.template);
  tabStrip.appendChild(entry);

  const created = createPanel(config);
  panel = created.panel;
  frame = created.frame;
  document.body.appendChild(panel);

  const api = Object.freeze({
    version: VERSION,
    get config() {
      return config;
    },
    open,
    close,
    destroy,
  });

  document.addEventListener("click", onDocumentClick, true);
  window.addEventListener("resize", updateBounds);
  resizeObserver = new ResizeObserver(updateBounds);
  resizeObserver.observe(sidebarFrame);
  updateBounds();
  window[SENTINEL_KEY] = api;
})();
