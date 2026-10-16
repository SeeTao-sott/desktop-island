import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Animator, Spring } from "./spring";
import { SPRING, fpsReporter } from "./motion";
import { api, displayName, formatSize, parentName, type Category, type Item, type OpResult, type ShelfData } from "./shelf-api";
import { reportOp, showError } from "./shelf-toast";
import { closeMenu, menuOpen, openMenu, type MenuEntry } from "./shelf-menu";
import { closeSheet, initSheet, sheetOpen, showSheet } from "./shelf-sheet";

/** 默认分类的图标；自己建的分类用文件夹图标 */
const ICONS: Record<string, string> = {
  软件: "#c-apps",
  文档: "#c-docs",
  图片: "#c-images",
  压缩包: "#c-archives",
  其他: "#c-other",
};

/** 面板和窗口右边的空隙（和 CSS 里 .panel 的 right/top 一致） */
const GAP = 10;
/** 收起时面板要滑出窗口外这么远，连阴影一起看不见（宽度按配置会变） */
let HIDDEN_X = 320 + GAP + 34;
/** 滑出时各分类依次跟上的间隔 */
const STAGGER_MS = 28;

interface ShelfState {
  open: boolean;
  pinned: boolean;
}
interface Config {
  shelf_hotkey: string;
  shelf_width: number;
}

const panel = document.getElementById("panel")!;
const list = document.getElementById("list")!;
const search = document.getElementById("search") as HTMLInputElement;
const foot = document.querySelector<HTMLElement>(".js-foot")!;
const removedLink = document.querySelector<HTMLButtonElement>(".js-removed")!;
const dropText = document.querySelector<HTMLElement>(".js-drop-text")!;
const tpl = document.getElementById("tpl-section") as HTMLTemplateElement;

const animator = new Animator(render, fpsReporter(document.getElementById("fps")!));
const slide = animator.add(new Spring(HIDDEN_X, SPRING.slide));
const fade = animator.add(new Spring(0, SPRING.fade));

// ---------- 分类 ----------
interface Section {
  name: string;
  el: HTMLElement;
  body: HTMLElement;
  inner: HTMLElement;
  items: HTMLElement;
  chev: SVGElement;
  count: HTMLElement;
  height: Spring; // 展开高度
  turn: Spring; // 箭头角度 0 → 1
  enter: Spring; // 滑出时的错落入场
  expanded: boolean;
}

const sections = new Map<string, Section>();
let data: ShelfData | null = null;
/** 当前搜索词（小写，已去空格）和每个分类里的匹配数 */
let query = "";
const matchCount = new Map<string, number>();

// 每个分类展开没有，记在本机（读写失败就用默认）
const EXPANDED_KEY = "shelf-expanded";
function loadExpanded(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "{}");
  } catch {
    return {};
  }
}
const expandedPref = loadExpanded();
function saveExpanded() {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(expandedPref));
  } catch {
    /* 存不了就算了 */
  }
}

function makeSection(cat: Category): Section {
  const frag = tpl.content.cloneNode(true) as DocumentFragment;
  const el = frag.querySelector<HTMLElement>(".sec")!;
  el.dataset.name = cat.name;
  el.querySelector(".sec-name")!.textContent = cat.name;
  el.querySelector(".sec-ic use")!.setAttribute("href", ICONS[cat.name] ?? "#c-folder");
  const s: Section = {
    name: cat.name,
    el,
    body: el.querySelector<HTMLElement>(".sec-body")!,
    inner: el.querySelector<HTMLElement>(".sec-inner")!,
    items: el.querySelector<HTMLElement>(".items")!,
    chev: el.querySelector<SVGElement>(".chev")!,
    count: el.querySelector<HTMLElement>(".count")!,
    height: animator.add(new Spring(0, SPRING.shape)),
    turn: animator.add(new Spring(0, SPRING.shape)),
    enter: animator.add(new Spring(0, SPRING.slide)),
    expanded: false,
  };
  const head = el.querySelector<HTMLElement>(".sec-head")!;
  head.addEventListener("click", () => {
    if (query) return; // 搜索时展开与否由搜索结果决定
    setExpanded(s, !s.expanded);
    expandedPref[s.name] = s.expanded;
    saveExpanded();
  });
  head.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showCategoryMenu(s, e.clientX, e.clientY);
  });
  // 内容高度变了（加了文件、图标加载完）就跟着调整
  new ResizeObserver(() => {
    if (isOpen(s)) {
      s.height.target = s.inner.offsetHeight;
      animator.kick();
    }
  }).observe(s.inner);
  return s;
}

/** 搜索时：有匹配的分类自动展开；不搜索时按用户自己的展开状态 */
function isOpen(s: Section) {
  return query ? (matchCount.get(s.name) ?? 0) > 0 : s.expanded;
}

function syncSection(s: Section, instant = false) {
  const open = isOpen(s);
  s.height.target = open ? s.inner.offsetHeight : 0;
  s.turn.target = open ? 1 : 0;
  if (instant) {
    s.height.value = s.height.target;
    s.turn.value = s.turn.target;
  }
  animator.kick();
}

function setExpanded(s: Section, next: boolean, instant = false) {
  s.expanded = next;
  syncSection(s, instant);
}

// ---------- 文件项 ----------
const itemEls = new Map<string, HTMLElement>();
const itemByPath = new Map<string, Item>();
/** 刚放进来的文件：闪一下提示它在哪 */
const freshPaths = new Set<string>();
let selected: string | null = null;

function subText(it: Item) {
  if (it.kind === "folder") return "文件夹";
  if (it.kind === "shortcut") return "快捷方式";
  const ext = it.name.includes(".") ? it.name.split(".").pop()!.toUpperCase() : "文件";
  return `${ext} · ${formatSize(it.size)}`;
}

function makeItem(it: Item): HTMLElement {
  const el = document.createElement("div");
  el.className = "item";
  el.innerHTML = `<div class="ic"></div><div class="meta"><div class="nm"></div><div class="sub"></div></div>`;
  el.addEventListener("click", () => select(el.dataset.path!));
  el.addEventListener("dblclick", () => openItem(el.dataset.path!));
  // 按住拖动 → 系统拖拽：可以拖到别的程序，也可以拖回架子的其他分类
  el.addEventListener("mousedown", (e) => {
    if (e.button === 0 && !(e.target instanceof HTMLInputElement)) press = { path: el.dataset.path!, x: e.clientX, y: e.clientY };
  });
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    select(el.dataset.path!);
    showItemMenu(el.dataset.path!, e.clientX, e.clientY);
  });
  return el;
}

function fillItem(el: HTMLElement, it: Item) {
  const changed = el.dataset.path !== it.path || el.dataset.modified !== String(it.modified);
  el.dataset.path = it.path;
  el.dataset.modified = String(it.modified);
  el.dataset.kind = it.kind;
  el.title = it.name;
  el.querySelector(".nm")!.textContent = displayName(it);
  el.querySelector(".sub")!.textContent = subText(it);
  if (changed) loadIcon(el, it);
}

// 图标：最多同时取 4 个，取过的记住
const iconCache = new Map<string, string>();
const iconQueue: (() => Promise<void>)[] = [];
let iconBusy = 0;
function pumpIcons() {
  while (iconBusy < 4 && iconQueue.length) {
    iconBusy++;
    iconQueue.shift()!().finally(() => {
      iconBusy--;
      pumpIcons();
    });
  }
}
function loadIcon(el: HTMLElement, it: Item, retry = true) {
  const box = el.querySelector<HTMLElement>(".ic")!;
  const key = `${it.path}|${it.modified}`;
  const put = (url: string | null) => {
    if (el.dataset.path !== it.path) return;
    box.replaceChildren();
    if (url) {
      const img = new Image();
      img.src = url;
      img.draggable = false;
      box.appendChild(img);
    }
  };
  const hit = iconCache.get(key);
  if (hit) return put(hit);
  iconQueue.push(async () => {
    const url = await api.icon(it.path, it.modified, it.kind === "image").catch(() => null);
    if (url) iconCache.set(key, url);
    put(url);
    // 刚放进来的文件，系统有时还没准备好图标：过一会儿再试一次
    if (!url && retry) window.setTimeout(() => el.dataset.path === it.path && loadIcon(el, it, false), 1500);
  });
  pumpIcons();
}

function select(path: string | null) {
  selected = path;
  for (const [p, el] of itemEls) el.classList.toggle("selected", p === path);
}

// ---------- 把 Rust 推来的数据画出来 ----------
function applyData(next: ShelfData) {
  data = next;
  const seen = new Set<string>();
  const firstRun = sections.size === 0;

  next.categories.forEach((cat, index) => {
    let s = sections.get(cat.name);
    const isNew = !s;
    if (!s) {
      s = makeSection(cat);
      sections.set(cat.name, s);
    }
    // 按顺序摆放
    if (list.children[index] !== s.el) list.insertBefore(s.el, list.children[index] ?? null);
    s.count.textContent = String(cat.items.length);
    s.el.classList.toggle("is-empty", cat.items.length === 0);

    const wanted = cat.items.map((it) => {
      seen.add(it.path);
      itemByPath.set(it.path, it);
      let el = itemEls.get(it.path);
      if (!el) {
        el = makeItem(it);
        itemEls.set(it.path, el);
      }
      fillItem(el, it);
      if (freshPaths.has(it.path)) {
        freshPaths.delete(it.path);
        el.classList.remove("fresh");
        void el.offsetWidth;
        el.classList.add("fresh");
      }
      return el;
    });
    // 只在顺序真的变了时才动 DOM
    const current = [...s.items.children];
    if (current.length !== wanted.length || wanted.some((el, i) => current[i] !== el)) s.items.replaceChildren(...wanted);

    if (firstRun || isNew) {
      // 第一次、或新出现的分类：按记住的状态，没记过的话有东西就展开
      setExpanded(s, expandedPref[cat.name] ?? cat.items.length > 0, firstRun);
    }
  });

  // 文件夹被删掉的分类
  for (const [name, s] of sections) {
    if (!next.categories.some((c) => c.name === name)) {
      s.el.remove();
      sections.delete(name);
    }
  }
  for (const [p, el] of itemEls) {
    if (!seen.has(p)) {
      el.remove();
      itemEls.delete(p);
      itemByPath.delete(p);
    }
  }
  if (selected && !seen.has(selected)) selected = null;

  removedLink.hidden = next.removedCount === 0;
  removedLink.textContent = `已移除 ${next.removedCount}`;
  applySearch();
  animator.kick();
}

// ---------- 搜索 ----------
const noResult = document.createElement("div");
noResult.className = "no-result";
noResult.hidden = true;
list.appendChild(noResult);

/** 名字里包含搜索词就算匹配（不分大小写；快捷方式按显示的名字算，空格分开的几个词要都包含） */
function matches(it: Item, q: string) {
  const name = `${displayName(it)} ${it.name}`.toLowerCase();
  return q.split(/\s+/).every((w) => name.includes(w));
}

function applySearch() {
  query = search.value.trim().toLowerCase();
  matchCount.clear();
  let total = 0;
  for (const [name, s] of sections) {
    let n = 0;
    for (const el of s.items.children as HTMLCollectionOf<HTMLElement>) {
      const it = itemByPath.get(el.dataset.path!);
      const hit = !query || (!!it && matches(it, query));
      el.hidden = !hit;
      if (hit) n++;
    }
    matchCount.set(name, n);
    total += n;
    // 搜索时没有匹配的分类先藏起来
    s.el.hidden = !!query && n === 0;
    syncSection(s);
  }
  noResult.hidden = !query || total > 0;
  noResult.textContent = `没找到「${search.value.trim()}」`;
  list.appendChild(noResult);
  // 选中的被筛掉了就换成第一个结果
  if (query && (!selected || itemEls.get(selected)?.hidden)) select(visibleItems()[0]?.dataset.path ?? null);
}
search.addEventListener("input", applySearch);

/** 当前看得见的文件项（按界面上的顺序） */
function visibleItems(): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>(".sec:not([hidden]) .item:not([hidden])")].filter((el) => {
    const s = sections.get(el.closest<HTMLElement>(".sec")!.dataset.name!);
    return !!s && isOpen(s);
  });
}

function moveSelection(step: number) {
  const items = visibleItems();
  if (!items.length) return;
  const i = items.findIndex((el) => el.dataset.path === selected);
  const next = items[Math.max(0, Math.min(items.length - 1, i < 0 ? 0 : i + step))];
  select(next.dataset.path!);
  next.scrollIntoView({ block: "nearest" });
}

// 搜索框里：↑↓ 选、回车打开、Esc 先清空再收回
search.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    moveSelection(e.key === "ArrowDown" ? 1 : -1);
  } else if (e.key === "Enter") {
    const target = selected && !itemEls.get(selected)?.hidden ? selected : visibleItems()[0]?.dataset.path;
    if (target) openItem(target);
  } else if (e.key === "Escape" && search.value) {
    e.stopPropagation();
    search.value = "";
    applySearch();
  }
});

// ---------- 操作 ----------
async function run(op: Promise<OpResult>) {
  try {
    const r = await op;
    r.moved.forEach((m) => freshPaths.add(m.to));
    // 放进去的分类如果是收起的，展开给用户看
    for (const m of r.moved) {
      const s = sections.get(parentName(m.to));
      if (s && !s.expanded && r.kind !== "remove") {
        setExpanded(s, true);
        expandedPref[s.name] = true;
      }
    }
    saveExpanded();
    reportOp(r, (id) => run(api.undo(id)));
    if (data) applyData(await api.list());
  } catch (e) {
    showError(String(e));
  }
}

function openItem(path: string) {
  api.open(path).catch((e) => showError(String(e)));
}

function showItemMenu(path: string, x: number, y: number) {
  const it = itemByPath.get(path);
  if (!it || !data) return;
  const here = parentName(path);
  const others: MenuEntry[] = data.categories
    .filter((c) => c.name !== here)
    .map((c) => ({ label: c.name, action: () => run(api.move([path], c.name)) }));
  openMenu(x, y, [
    { label: "打开", action: () => openItem(path) },
    { label: "在资源管理器中显示", action: () => api.reveal(path).catch((e) => showError(String(e))) },
    { label: "重命名", action: () => startRename(path) },
    { label: "移到其他分类", sub: others },
    { label: "-" },
    { label: "从架子移除", danger: true, action: () => run(api.remove([path])) },
  ]);
}

// ---------- 分类：新建、改名、移除 ----------
function showCategoryMenu(s: Section, x: number, y: number) {
  const cat = data?.categories.find((c) => c.name === s.name);
  if (!cat) return;
  if (cat.builtin) {
    openMenu(x, y, [
      { label: s.expanded ? "收起" : "展开", action: () => toggleSection(s) },
      { label: "-" },
      { label: "默认分类不能改名或移除", disabled: true },
    ]);
    return;
  }
  const empty = cat.items.length === 0;
  openMenu(x, y, [
    { label: s.expanded ? "收起" : "展开", action: () => toggleSection(s) },
    { label: "重命名分类", action: () => startRenameCategory(s) },
    { label: "-" },
    {
      label: empty ? "移除这个分类" : "移除分类（里面还有东西）",
      danger: true,
      disabled: !empty,
      action: () => run(api.removeCategory(s.name)),
    },
  ]);
}

function toggleSection(s: Section) {
  setExpanded(s, !s.expanded);
  expandedPref[s.name] = s.expanded;
  saveExpanded();
}

/** 就地输入框：回车确认、Esc 取消、点别处也算确认（空的就取消） */
function inlineInput(host: HTMLElement, initial: string, onCommit: (v: string) => void, className = "rename") {
  const input = document.createElement("input");
  input.className = className;
  input.value = initial;
  input.spellcheck = false;
  host.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    input.replaceWith(host);
    const v = input.value.trim();
    if (commit && v && v !== initial) onCommit(v);
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("blur", () => finish(true));
}

function startRenameCategory(s: Section) {
  // 整行标题换成输入框（输入框不能放在按钮里面）
  const head = s.el.querySelector<HTMLElement>(".sec-head")!;
  inlineInput(head, s.name, (v) => {
    // 展开状态跟着新名字走（先记下，新分类一出现就按它展开）
    expandedPref[v] = s.expanded;
    saveExpanded();
    run(api.renameCategory(s.name, v));
  }, "rename cat-rename");
}

// 标题旁的"＋"：在列表末尾出现一个输入框
const addCat = document.querySelector<HTMLButtonElement>(".js-add-cat")!;
addCat.addEventListener("click", () => {
  const row = document.createElement("div");
  row.className = "new-cat";
  const holder = document.createElement("span");
  list.insertBefore(row, noResult);
  row.appendChild(holder);
  row.scrollIntoView({ block: "nearest" });
  inlineInput(
    holder,
    "",
    async (v) => {
      try {
        // 新分类默认展开，露出"把文件拖到这里"
        expandedPref[v] = true;
        saveExpanded();
        await api.createCategory(v);
        applyData(await api.list());
      } catch (e) {
        showError(String(e));
      }
    },
    "rename new-cat-input",
  );
  const input = row.querySelector<HTMLInputElement>("input")!;
  input.placeholder = "新分类的名字，比如 FYP";
  // 输入框收起后这一行也去掉
  input.addEventListener("blur", () => window.setTimeout(() => row.remove(), 0));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "Escape") window.setTimeout(() => row.remove(), 0);
  });
});

// ---------- 拖出去 / 在分类之间拖 ----------
let press: { path: string; x: number; y: number } | null = null;
let draggingPath: string | null = null;

window.addEventListener("mousemove", (e) => {
  if (!press || !(e.buttons & 1)) return;
  if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6) return;
  const path = press.path;
  press = null;
  select(path);
  draggingPath = path;
  itemEls.get(path)?.classList.add("dragging-out");
  api.dragOut([path]).catch((err) => {
    showError(String(err));
    endDragOut();
  });
});
window.addEventListener("mouseup", () => (press = null));

function endDragOut() {
  if (draggingPath) itemEls.get(draggingPath)?.classList.remove("dragging-out");
  draggingPath = null;
}
listen("shelf-dragout-done", endDragOut);

// 重命名：就地改，回车确认、Esc 取消、点别处也算确认
function startRename(path: string) {
  const el = itemEls.get(path);
  const it = itemByPath.get(path);
  if (!el || !it) return;
  const nm = el.querySelector<HTMLElement>(".nm")!;
  const isShortcut = it.kind === "shortcut";
  const ext = isShortcut ? it.name.slice(displayName(it).length) : "";
  const input = document.createElement("input");
  input.className = "rename";
  input.value = displayName(it);
  input.spellcheck = false;
  nm.replaceWith(input);
  input.focus();
  // 默认只选中主名，不选扩展名
  const dot = isShortcut || it.isDir ? -1 : input.value.lastIndexOf(".");
  input.setSelectionRange(0, dot > 0 ? dot : input.value.length);

  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    input.replaceWith(nm);
    const value = input.value.trim();
    if (commit && value && value !== displayName(it)) run(api.rename(path, value + ext));
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

removedLink.addEventListener("click", () => api.openRemoved().catch((e) => showError(String(e))));

// 键盘：回车打开、F2 改名、Delete 移到「已移除」、Esc 收回
let lastActivity = 0;
window.addEventListener("keydown", (e) => {
  // 在打字（搜索、改名）：告诉 Rust 先别因为鼠标不在面板上而收回（最多 0.3 秒报一次）
  if (e.key !== "Escape" && e.timeStamp - lastActivity > 300) {
    lastActivity = e.timeStamp;
    api.activity();
  }
  if (e.target instanceof HTMLInputElement && e.target.classList.contains("rename")) return;
  if (e.key === "Escape") {
    if (menuOpen()) return closeMenu();
    if (sheetOpen()) return closeSheet();
    invoke("shelf_cmd", { action: "hide" }).catch(() => {});
    return;
  }
  if (!selected || e.target === search) return;
  if (e.key === "Enter") openItem(selected);
  if (e.key === "F2") startRename(selected);
  if (e.key === "Delete") run(api.remove([selected]));
});

// ---------- 从外面拖文件进来 ----------
let dropTarget: string | null = null;

function sectionAt(x: number, y: number): Section | null {
  const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>(".sec");
  return hit ? (sections.get(hit.dataset.name ?? "") ?? null) : null;
}

function setDropTarget(name: string | null) {
  dropTarget = name;
  for (const s of sections.values()) s.el.classList.toggle("drop-target", s.name === name);
  dropText.textContent = name ? `松手放进「${name}」` : "松手按类型自动分类";
}

// 拖放事件来自 Rust 里架子自己的接收（shelf_drop.rs），位置是相对窗口的物理像素
interface DragPayload {
  kind: "enter" | "over" | "leave" | "drop";
  paths: string[];
  x: number;
  y: number;
}
listen<DragPayload>("shelf-drag", (e) => {
  const p = e.payload;
  if (p.kind === "leave") {
    panel.classList.remove("dragging");
    setDropTarget(null);
    return;
  }
  const x = p.x / devicePixelRatio;
  const y = p.y / devicePixelRatio;
  if (p.kind === "enter" || p.kind === "over") {
    panel.classList.add("dragging");
    setDropTarget(sectionAt(x, y)?.name ?? null);
    return;
  }
  // 松手
  panel.classList.remove("dragging");
  const target = sectionAt(x, y)?.name ?? null;
  setDropTarget(null);
  if (p.paths.length) run(api.put(p.paths, target));
});

// ---------- 每帧绘制：只改 transform / opacity / 高度 ----------
function render() {
  const hidden = slide.value >= HIDDEN_X - 0.5 && slide.target === HIDDEN_X;
  // 完全收起后直接隐藏，省掉绘制
  panel.style.visibility = hidden ? "hidden" : "visible";
  if (hidden) return;
  panel.style.transform = `translate3d(${slide.value}px, 0, 0)`;
  panel.style.opacity = String(Math.min(Math.max(fade.value, 0), 1));

  for (const s of sections.values()) {
    s.body.style.height = `${Math.max(0, s.height.value)}px`;
    s.chev.style.transform = `rotate(${s.turn.value * 90}deg)`;
    const e = s.enter.value; // 0 = 到位，1 = 还在右边
    s.el.style.transform = `translate3d(${e * 40}px, 0, 0)`;
    s.el.style.opacity = String(Math.min(Math.max(1 - e, 0), 1));
  }
}

// ---------- 滑出 / 收回（由 Rust 决定，页面只负责动画） ----------
let staggerTimers: number[] = [];

function applyState(st: ShelfState) {
  staggerTimers.forEach(clearTimeout);
  staggerTimers = [];
  document.body.dataset.open = String(st.open);
  slide.target = st.open ? 0 : HIDDEN_X;
  fade.target = st.open ? 1 : 0;

  if (st.open) {
    // 各分类从右往左依次跟上，像游戏菜单一样有层次
    [...sections.values()].forEach((s, i) => {
      s.enter.value = 1;
      s.enter.velocity = 0;
      s.enter.target = 1;
      staggerTimers.push(
        window.setTimeout(() => {
          s.enter.target = 0;
          animator.kick();
        }, 40 + i * STAGGER_MS),
      );
    });
    // 快捷键打开的：直接可以打字搜索（等窗口真正拿到焦点后再放光标）
    if (st.pinned) staggerTimers.push(window.setTimeout(() => search.focus(), 60));
  } else {
    search.blur();
    closeMenu();
    closeSheet();
  }
  animator.kick();
}

listen<ShelfState>("shelf-state", (e) => applyState(e.payload));
listen<ShelfData>("shelf-items", (e) => applyData(e.payload));
// 托盘里点了"从桌面搬进架子…"/"搬回桌面…"
initSheet(() => api.list().then(applyData).catch(() => {}));
listen<string>("shelf-sheet", (e) => showSheet(e.payload));
api.list().then(applyData).catch((e) => showError(`读取架子失败：${e}`));

// ---------- 告诉 Rust 哪块区域算"在架子上"：面板 + 右边的空隙 ----------
function sendHitRect() {
  const w = window.innerWidth;
  const rect = { x: w - GAP - panel.offsetWidth, y: GAP, w: panel.offsetWidth + GAP, h: window.innerHeight - GAP * 2 };
  invoke("shelf_set_hit_rect", { rect }).catch(() => {});
}
window.addEventListener("resize", sendHitRect);
sendHitRect();

// ---------- 配置：面板宽度、底部提示里写上快捷键 ----------
invoke<Config>("config_get")
  .then((cfg) => {
    if (cfg.shelf_width) {
      const wasHidden = slide.target === HIDDEN_X;
      panel.style.width = `${cfg.shelf_width}px`;
      HIDDEN_X = cfg.shelf_width + GAP + 34;
      if (wasHidden) slide.value = slide.target = HIDDEN_X;
      sendHitRect();
      render();
    }
    const key = cfg.shelf_hotkey?.trim();
    foot.innerHTML = key ? `右边缘停一下，或按 <kbd>${key.replace(/[<>&]/g, "")}</kbd>` : "鼠标推到右边缘停一下";
  })
  .catch(() => {});

// 预热：启动后在看不见的状态下把面板完整画一次（中文字形、玻璃阴影都先准备好），
// 第一次滑出时就不用临时去画，避免卡一下
async function warmUp() {
  await document.fonts?.ready;
  panel.style.visibility = "visible";
  panel.style.transform = "translate3d(0, 0, 0)";
  panel.style.opacity = "0.002";
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  if (slide.target === HIDDEN_X) render();
}

render();
warmUp();
