import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Animator, Spring } from "./spring";
import { SPRING, fpsReporter } from "./motion";
import { api, displayName, formatSize, parentName, type Category, type Item, type OpResult, type ShelfData } from "./shelf-api";
import { reportOp, showError } from "./shelf-toast";
import { closeMenu, menuOpen, openMenu, type MenuEntry } from "./shelf-menu";

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
  el.querySelector(".sec-head")!.addEventListener("click", () => {
    setExpanded(s, !s.expanded);
    expandedPref[s.name] = s.expanded;
    saveExpanded();
  });
  // 内容高度变了（加了文件、图标加载完）就跟着调整
  new ResizeObserver(() => {
    if (s.expanded) {
      s.height.target = s.inner.offsetHeight;
      animator.kick();
    }
  }).observe(s.inner);
  return s;
}

function setExpanded(s: Section, next: boolean, instant = false) {
  s.expanded = next;
  s.height.target = next ? s.inner.offsetHeight : 0;
  s.turn.target = next ? 1 : 0;
  if (instant) {
    s.height.value = s.height.target;
    s.turn.value = s.turn.target;
  }
  animator.kick();
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

    if (firstRun) {
      // 第一次：按记住的状态，没记过的话有东西就展开
      setExpanded(s, expandedPref[cat.name] ?? cat.items.length > 0, true);
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

// 搜索框：阶段 3 做完整搜索，这里先按名字简单过滤
function applySearch() {
  const q = search.value.trim().toLowerCase();
  for (const [p, el] of itemEls) {
    const it = itemByPath.get(p);
    el.hidden = !!q && !!it && !it.name.toLowerCase().includes(q);
  }
}
search.addEventListener("input", applySearch);

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
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement && e.target.classList.contains("rename")) return;
  if (e.key === "Escape") {
    if (menuOpen()) return closeMenu();
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
  }
  animator.kick();
}

listen<ShelfState>("shelf-state", (e) => applyState(e.payload));
listen<ShelfData>("shelf-items", (e) => applyData(e.payload));
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
