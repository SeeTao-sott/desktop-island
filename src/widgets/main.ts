// 桌面小组件的主页面：摆放、编辑模式（拖动 + 吸附网格 + 换尺寸）、换主题、保存布局、点击区域上报。
// 所有位置、尺寸、主题切换、编辑模式的出现消失都走灵动岛同一套弹簧；静止时不跑动画循环。
//
// 组件（kinds/）只给数据，主题（skins/）决定外观；这里把两者接起来，自己不关心任何一种组件长什么样。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Animator, Spring } from "../spring";
import { SPRING, fpsReporter } from "../motion";
import { MODULES, moduleOf } from "./registry";
import { SKINS, skinOf } from "./skins/registry";
import type { Frame, Kind, Pt, Skin, View } from "./skins/types";
import { gridOf, type Cell } from "./grid";
import { FALLBACK } from "./views";
import { initTheme } from "./theme";
import { SIZES, settingsWithDefaults, type Model, type Settings, type SizeKey, type WidgetModule } from "./types";

interface Item {
  id: string;
  kind: string;
  size: SizeKey;
  /** 方形网格里的位置 */
  col: number;
  row: number;
  /** 蜂巢网格里的位置（第一次切到六边形主题时才有） */
  hex?: Cell;
  settings: Settings;
}

interface Layout {
  version: 1;
  /** 现在用的主题 */
  skin?: string;
  items: Item[];
}

interface Live {
  item: Item;
  mod: WidgetModule;
  model: Model<unknown>;
  /** 最近一次数据，换主题 / 换尺寸后立刻用它画 */
  data: unknown;
  el: HTMLElement;
  host: HTMLElement;
  ring: SVGSVGElement;
  chips: HTMLElement;
  remove: HTMLElement;
  panel: HTMLElement | null;
  frame: Frame | null;
  view: View<unknown> | null;
  x: Spring;
  y: Spring;
  w: Spring;
  h: Spring;
  s: Spring;
  /** 正在缩小消失（被移除） */
  removing?: boolean;
}

const board = document.getElementById("board")!;
const backdrop = document.getElementById("backdrop")!;
const slot = document.getElementById("slot")!;
const editBar = document.getElementById("edit-bar")!;
const library = document.getElementById("library")!;
const skinBar = document.getElementById("skins")!;
const fpsEl = document.getElementById("fps")!;

const live: Live[] = [];
let editing = false;
let paused = false;
let skin: Skin = SKINS[0];
/** 换主题过渡：1 = 正常显示，0 = 缩小淡出的最低点（在这一刻换外观） */
const morph = new Spring(1, SPRING.fade);
let pendingSkin: Skin | null = null;

const editFade = new Spring(0, SPRING.fade);
const animator = new Animator(applyFrame, (frames) => {
  fpsReporter(fpsEl)(frames);
  if (!editing) reportHits();
});
animator.add(editFade);
animator.add(morph);

// ---------------- 网格 ----------------

const grid = () => gridOf(skin.grid);
const W = () => window.innerWidth;
const H = () => window.innerHeight;

function cellOf(item: Item): Cell | undefined {
  return grid().id === "hex" ? item.hex : { col: item.col, row: item.row };
}
function setCell(item: Item, c: Cell) {
  if (grid().id === "hex") item.hex = { ...c };
  else Object.assign(item, { col: c.col, row: c.row });
}

function fits(size: SizeKey, cell: Cell, exceptId: string | null) {
  const g = grid();
  if (!g.inBounds(size, cell, W(), H())) return false;
  const mine = new Set(g.cells(size, cell));
  for (const l of live) {
    if (l.item.id === exceptId || l.removing) continue;
    const c = cellOf(l.item);
    if (!c) continue;
    if (g.cells(l.item.size, c).some((k) => mine.has(k))) return false;
  }
  return true;
}

/** 离某个位置（外框左上角像素）最近的空位；整块屏幕都放不下就返回 null */
function nearestFree(size: SizeKey, x: number, y: number, exceptId: string | null): Cell | null {
  const g = grid();
  let best: Cell | null = null;
  let bestD = Infinity;
  for (const c of g.all(W(), H())) {
    const o = g.origin(size, c);
    const d = (o.x - x) ** 2 + (o.y - y) ** 2;
    if (d < bestD && fits(size, c, exceptId)) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

// ---------------- 组件的创建、外观和动画 ----------------

const GEAR =
  '<svg viewBox="0 0 24 24"><path d="M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zm8.6 2.3l-1.9-.4a7 7 0 0 0-.7-1.6l1.1-1.6-1.6-1.6-1.6 1.1a7 7 0 0 0-1.6-.7l-.4-1.9h-2.2l-.4 1.9a7 7 0 0 0-1.6.7L6.1 5.6 4.5 7.2l1.1 1.6a7 7 0 0 0-.7 1.6l-1.9.4v2.2l1.9.4c.2.6.4 1.1.7 1.6l-1.1 1.6 1.6 1.6 1.6-1.1c.5.3 1 .5 1.6.7l.4 1.9h2.2l.4-1.9a7 7 0 0 0 1.6-.7l1.6 1.1 1.6-1.6-1.1-1.6c.3-.5.5-1 .7-1.6l1.9-.4z"/></svg>';
const SVG_NS = "http://www.w3.org/2000/svg";

function mount(item: Item): Live | null {
  const mod = moduleOf(item.kind);
  if (!mod) return null;
  if (!mod.sizes.includes(item.size)) item.size = mod.defaultSize;
  item.settings = settingsWithDefaults(mod, item.settings ?? {});

  const el = document.createElement("div");
  el.className = "widget";
  el.dataset.kind = mod.kind;
  const host = document.createElement("div");
  host.className = "skin-host";
  const ring = document.createElementNS(SVG_NS, "svg");
  ring.setAttribute("class", "edit-ring");
  const chips = document.createElement("div");
  chips.className = "edit-chips glass";
  const remove = document.createElement("button");
  remove.className = "remove-btn";
  remove.title = "移除";
  remove.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 11h14v2H5z"/></svg>';
  el.append(host, ring, chips, remove);
  board.appendChild(el);

  const box = grid().box(item.size);
  const pos = grid().origin(item.size, cellOf(item) ?? { col: 0, row: 0 });
  const l: Live = {
    item,
    mod,
    model: mod.model(item.settings),
    data: undefined,
    el,
    host,
    ring,
    chips,
    remove,
    panel: null,
    frame: null,
    view: null,
    x: animator.add(new Spring(pos.x, SPRING.shape)),
    y: animator.add(new Spring(pos.y, SPRING.shape)),
    w: animator.add(new Spring(box.w, SPRING.shape)),
    h: animator.add(new Spring(box.h, SPRING.shape)),
    s: animator.add(new Spring(1, SPRING.shape)),
  };
  buildSkin(l);
  // 数据来了交给当前的界面；界面换了（换主题 / 换尺寸）也不用重新订阅
  l.model.subscribe((d) => {
    l.data = d;
    l.view?.update(d);
  });
  buildChips(l);
  bindDrag(l);
  remove.addEventListener("click", () => removeWidget(l));
  // 编辑时鼠标进入哪个组件，就显示哪个的尺寸按钮（一直留着，直到进入别的组件）
  el.addEventListener("pointerenter", () => {
    if (editing && !l.removing) setActive(l);
  });
  live.push(l);
  if (paused) l.model.setPaused(true);
  return l;
}

/** 按当前主题和尺寸重新画这个组件的外框和界面 */
function buildSkin(l: Live) {
  l.view?.destroy();
  l.frame?.destroy();
  l.host.replaceChildren();
  l.host.className = "skin-host";
  const { w, h } = grid().box(l.item.size);
  const { frame, content } = skin.frame(l.host, l.item.size, w, h);
  const kind = l.item.kind as Kind;
  // 主题专门写了这种组件就用主题的，否则用通用界面
  const view = (skin.views[kind] ?? FALLBACK[kind]) as unknown as ((root: HTMLElement, ctx: object) => View<unknown>) | undefined;
  l.frame = frame;
  l.view = view
    ? view(content, { size: l.item.size, w, h, act: (a: string) => l.model.act?.(a) })
    : null;
  if (l.data !== undefined) l.view?.update(l.data);
  frame.setPaused(paused);

  // 编辑模式的虚线轮廓 + 移除按钮放在形状的左上角
  const pts = skin.outline(l.item.size, w, h);
  l.ring.setAttribute("viewBox", `0 0 ${w} ${h}`);
  l.ring.setAttribute("preserveAspectRatio", "none");
  l.ring.innerHTML = `<polygon points="${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}" />`;
  const corner = pts.reduce((a, b) => (b[0] + b[1] < a[0] + a[1] ? b : a));
  l.remove.style.left = `${corner[0] - 12}px`;
  l.remove.style.top = `${corner[1] - 12}px`;
}

function buildChips(l: Live) {
  l.chips.replaceChildren();
  for (const size of l.mod.sizes) {
    const b = document.createElement("button");
    b.className = "chip" + (size === l.item.size ? " on" : "");
    b.textContent = SIZES[size].label;
    b.title = `${SIZES[size].cols}×${SIZES[size].rows}`;
    b.addEventListener("click", () => resize(l, size));
    l.chips.appendChild(b);
  }
  if (l.mod.settings?.length) {
    const g = document.createElement("button");
    g.className = "chip";
    g.title = "设置";
    g.innerHTML = GEAR;
    g.addEventListener("click", () => toggleSettings(l));
    l.chips.appendChild(g);
  }
}

/** 编辑模式里的组件设置：一列开关，改了立刻生效 */
function toggleSettings(l: Live) {
  if (l.panel) {
    l.panel.remove();
    l.panel = null;
    return;
  }
  const p = document.createElement("div");
  p.className = "w-settings";
  const change = (key: string, value: unknown) => {
    l.item.settings = { ...l.item.settings, [key]: value };
    l.model.setSettings?.(l.item.settings);
  };
  for (const d of l.mod.settings ?? []) {
    if (d.options) {
      // "选一个"：一排小按钮
      const row = document.createElement("div");
      row.className = "set-choice";
      const name = document.createElement("span");
      name.textContent = d.label;
      const seg = document.createElement("div");
      seg.className = "set-seg";
      for (const o of d.options) {
        const b = document.createElement("button");
        b.className = l.item.settings[d.key] === o.value ? "on" : "";
        if (o.swatch) {
          // 色块：按钮本身就是这个颜色
          b.classList.add("swatch");
          b.style.setProperty("--sw", o.value);
          b.title = o.label;
        } else b.textContent = o.label;
        b.addEventListener("click", () => {
          change(d.key, o.value);
          seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
        });
        seg.appendChild(b);
      }
      row.append(name, seg);
      p.appendChild(row);
      continue;
    }
    const lab = document.createElement("label");
    lab.textContent = d.label;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = l.item.settings[d.key] === true;
    input.addEventListener("change", () => change(d.key, input.checked));
    lab.appendChild(input);
    p.appendChild(lab);
  }
  // 设置面板里的点击不当作拖动
  p.addEventListener("pointerdown", (e) => e.stopPropagation());
  l.el.appendChild(p);
  l.panel = p;
}

function setActive(l: Live | null) {
  for (const o of live) o.el.classList.toggle("active", o === l);
}

function closeAllSettings() {
  for (const l of live) {
    l.panel?.remove();
    l.panel = null;
  }
}

function resize(l: Live, size: SizeKey) {
  if (size === l.item.size) return;
  const cur = cellOf(l.item)!;
  // 原位放得下就原位，放不下找最近的空位；哪里都放不下就不换
  let spot: Cell | null = cur;
  if (!fits(size, cur, l.item.id)) {
    const o = grid().origin(size, cur);
    spot = nearestFree(size, o.x, o.y, l.item.id);
  }
  if (!spot) return;
  l.item.size = size;
  setCell(l.item, spot);
  buildSkin(l);
  buildChips(l);
  settle(l);
}

/** 弹回网格上的位置 */
function settle(l: Live) {
  const g = grid();
  const c = cellOf(l.item)!;
  const o = g.origin(l.item.size, c);
  const b = g.box(l.item.size);
  l.x.target = o.x;
  l.y.target = o.y;
  l.w.target = b.w;
  l.h.target = b.h;
  l.s.target = 1;
  animator.kick();
}

function applyFrame() {
  const e = editFade.value;
  backdrop.style.opacity = String(e);
  document.body.style.setProperty("--edit", String(e));
  editBar.style.opacity = String(e);
  editBar.style.transform = `translate(-50%, ${(1 - e) * -12}px)`;

  // 换主题：缩到最低点时换外观，再弹回来
  if (pendingSkin && morph.value < 0.08) applySkin();
  const m = Math.max(0, Math.min(1, morph.value));
  for (const l of [...live]) {
    l.el.style.width = `${l.w.value}px`;
    l.el.style.height = `${l.h.value}px`;
    const s = Math.max(0, l.s.value) * (0.82 + 0.18 * m);
    l.el.style.transform = `translate(${l.x.value}px, ${l.y.value}px) scale(${s})`;
    const fade = l.removing ? Math.max(0, Math.min(1, l.s.value)) : 1;
    l.el.style.opacity = String(fade * m);
    if (l.removing && l.s.value < 0.05) finishRemove(l);
  }
}

// ---------------- 主题 ----------------

function renderSkinBar() {
  skinBar.replaceChildren();
  for (const s of SKINS) {
    const b = document.createElement("button");
    b.className = "skin-btn" + (s.id === (pendingSkin ?? skin).id ? " on" : "");
    b.textContent = s.name;
    b.addEventListener("click", () => setSkin(s.id));
    skinBar.appendChild(b);
  }
}

/** 一键换主题（所有组件一起换） */
function setSkin(id: string) {
  const next = skinOf(id);
  if (next.id === (pendingSkin ?? skin).id) return;
  pendingSkin = next;
  morph.target = 0;
  renderSkinBar();
  animator.kick();
}

function applySkin() {
  const next = pendingSkin!;
  pendingSkin = null;
  const from = grid();
  skin = next;
  document.body.dataset.skin = skin.id;
  // 第一次到这种网格：从现在的位置找最近的空位（从左上往右下依次放）
  if (from.id !== grid().id) {
    const order = [...live].filter((l) => !l.removing).sort((a, b) => a.y.target - b.y.target || a.x.target - b.x.target);
    for (const l of order) if (!cellOf(l.item)) setCell(l.item, { col: -99, row: -99 });
    for (const l of order) {
      const c = cellOf(l.item)!;
      if (c.col >= 0 && fits(l.item.size, c, l.item.id)) continue;
      setCell(l.item, { col: -99, row: -99 });
      // 往左上角拉近一些找空位：大家挤在一起，才像蜂巢一样拼好
      const spot = nearestFree(l.item.size, l.x.target * 0.5, l.y.target * 0.5, l.item.id);
      if (spot) setCell(l.item, spot);
    }
  }
  for (const l of live) {
    if (l.removing) continue;
    buildSkin(l);
    settle(l);
  }
  morph.target = 1;
  save();
}

// ---------------- 组件库：添加和移除 ----------------

function removeWidget(l: Live) {
  if (l.removing) return;
  l.removing = true;
  l.panel?.remove();
  l.s.target = 0;
  animator.kick();
}

function finishRemove(l: Live) {
  const i = live.indexOf(l);
  if (i < 0) return;
  live.splice(i, 1);
  l.view?.destroy();
  l.frame?.destroy();
  l.model.destroy();
  l.el.remove();
  animator.remove(l.x, l.y, l.w, l.h, l.s);
  renderLibrary();
}

function addWidget(mod: WidgetModule) {
  // 先找默认尺寸的空位（离左上角最近），放不下就试更小的尺寸
  const order: SizeKey[] = [mod.defaultSize, ...mod.sizes.filter((s) => s !== mod.defaultSize).reverse()];
  for (const size of order) {
    const spot = nearestFree(size, 0, 0, null);
    if (!spot) continue;
    const item: Item = { id: `${mod.kind}-${Date.now().toString(36)}`, kind: mod.kind, size, col: 0, row: 0, settings: {} };
    setCell(item, spot);
    // 另一种网格的位置等切过去时再找
    if (grid().id === "hex") Object.assign(item, nearestRect(size, spot));
    const l = mount(item);
    if (!l) return;
    // 从小一点弹出来
    l.s.value = 0.6;
    settle(l);
    applyFrame();
    showLibrary(false);
    return;
  }
  libraryMessage("屏幕上放不下了，先移除或缩小别的组件");
}

/** 在蜂巢网格里加组件时，顺便给它一个方形网格里的位置 */
function nearestRect(size: SizeKey, hexCell: Cell): Cell {
  const o = gridOf("hex").origin(size, hexCell);
  const r = gridOf("rect").nearest(size, o.x, o.y, W(), H());
  return { col: Math.max(0, r.col), row: Math.max(0, r.row) };
}

function renderLibrary(msg = "") {
  library.replaceChildren();
  const title = document.createElement("div");
  title.className = "lib-title";
  title.textContent = "添加组件";
  library.appendChild(title);
  for (const mod of MODULES) {
    const row = document.createElement("button");
    row.className = "lib-row";
    const count = live.filter((l) => l.item.kind === mod.kind && !l.removing).length;
    row.innerHTML = `<span class="lib-name"></span><span class="lib-count">${count ? `已有 ${count} 个` : ""}</span><span class="lib-add">＋</span>`;
    row.querySelector(".lib-name")!.textContent = mod.name;
    row.addEventListener("click", () => addWidget(mod));
    library.appendChild(row);
  }
  if (msg) {
    const m = document.createElement("div");
    m.className = "lib-msg";
    m.textContent = msg;
    library.appendChild(m);
  }
}

function libraryMessage(msg: string) {
  renderLibrary(msg);
}

function showLibrary(on: boolean) {
  if (on) renderLibrary();
  library.hidden = !on;
}

document.querySelector(".js-library")!.addEventListener("click", () => showLibrary(!!library.hidden));

// ---------------- 拖动 ----------------

function bindDrag(l: Live) {
  l.el.addEventListener("pointerdown", (e) => {
    if (!editing || l.removing || e.button !== 0 || (e.target as HTMLElement).closest(".edit-chips, .remove-btn, .w-settings")) return;
    showLibrary(false);
    e.preventDefault();
    closeAllSettings();
    l.el.setPointerCapture(e.pointerId);
    l.el.classList.add("dragging");
    const offX = e.clientX - l.x.value;
    const offY = e.clientY - l.y.value;
    l.s.target = 1.04;
    let spot = cellOf(l.item)!;
    showSlot(l.item.size, spot);

    const move = (ev: PointerEvent) => {
      l.x.target = ev.clientX - offX;
      l.y.target = ev.clientY - offY;
      // 松手会落在哪：最接近的格子；被占了就找附近的空位
      const g = grid();
      const c = g.nearest(l.item.size, l.x.target, l.y.target, W(), H());
      const s = fits(l.item.size, c, l.item.id) ? c : nearestFree(l.item.size, l.x.target, l.y.target, l.item.id);
      if (s && (s.col !== spot.col || s.row !== spot.row)) {
        spot = s;
        showSlot(l.item.size, spot);
      }
      animator.kick();
    };
    const up = () => {
      l.el.removeEventListener("pointermove", move);
      l.el.removeEventListener("pointerup", up);
      l.el.removeEventListener("pointercancel", up);
      l.el.classList.remove("dragging");
      slot.hidden = true;
      setCell(l.item, spot);
      settle(l);
    };
    l.el.addEventListener("pointermove", move);
    l.el.addEventListener("pointerup", up);
    l.el.addEventListener("pointercancel", up);
    animator.kick();
  });
}

/** 落点提示：和组件同样的形状 */
function showSlot(size: SizeKey, spot: Cell) {
  const g = grid();
  const b = g.box(size);
  const o = g.origin(size, spot);
  const pts = skin.outline(size, b.w, b.h);
  slot.hidden = false;
  slot.style.width = `${b.w}px`;
  slot.style.height = `${b.h}px`;
  slot.style.transform = `translate(${o.x}px, ${o.y}px)`;
  slot.style.clipPath = `polygon(${pts.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(",")})`;
}

// ---------------- 编辑模式、保存、点击区域 ----------------

function setEditing(on: boolean) {
  if (on === editing) return;
  editing = on;
  document.body.classList.toggle("editing", on);
  editFade.target = on ? 1 : 0;
  if (on) renderSkinBar();
  else {
    closeAllSettings();
    setActive(null);
    showLibrary(false);
    save();
  }
  animator.kick();
}

function layout(): Layout {
  return { version: 1, skin: (pendingSkin ?? skin).id, items: live.filter((l) => !l.removing).map((l) => ({ ...l.item })) };
}

async function save() {
  try {
    await invoke("widgets_layout_save", { layout: layout() });
  } catch (e) {
    console.error(e);
  }
}

/** 告诉 Rust 每个组件的形状轮廓：只有形状里面接收点击，其余地方（包括圆角、切角外面）点击穿透 */
function reportHits() {
  const rects = live
    .filter((l) => !l.removing)
    .map((l) => {
      const x = l.x.target;
      const y = l.y.target;
      const w = l.w.target;
      const h = l.h.target;
      const pts: Pt[] = skin.outline(l.item.size, w, h).map(([px, py]) => [x + px, y + py]);
      return { x, y, w, h, pts };
    });
  invoke("widgets_set_hits", { rects }).catch(() => {});
}

document.querySelector(".js-done")!.addEventListener("click", () => {
  invoke("widgets_cmd", { action: "edit-off" }).catch(() => {});
});

listen<boolean>("widgets-edit", (e) => setEditing(e.payload));
listen<boolean>("widgets-paused", (e) => {
  paused = e.payload;
  for (const l of live) {
    l.model.setPaused(paused);
    l.frame?.setPaused(paused);
  }
});
// 托盘里"切换小组件主题"：换到下一个
listen("widgets-skin-next", () => {
  const cur = (pendingSkin ?? skin).id;
  const i = SKINS.findIndex((s) => s.id === cur);
  setSkin(SKINS[(i + 1) % SKINS.length].id);
});

// 屏幕大小变了：放不下的组件挪到最近的空位
window.addEventListener("resize", () => {
  for (const l of live) {
    const c = cellOf(l.item);
    if (!c || !fits(l.item.size, c, l.item.id)) {
      const s = nearestFree(l.item.size, l.x.target, l.y.target, l.item.id);
      if (s) setCell(l.item, s);
    }
    settle(l);
  }
});

// ---------------- 启动 ----------------

function defaultLayout(): Layout {
  return { version: 1, skin: "square", items: [{ id: "clock-1", kind: "clock", size: "medium", col: 0, row: 0, settings: {} }] };
}

async function start() {
  let saved: Layout | null = null;
  try {
    saved = await invoke<Layout | null>("widgets_layout_get");
  } catch {
    saved = null;
  }
  const lay = saved && Array.isArray(saved.items) ? saved : defaultLayout();
  skin = skinOf(lay.skin ?? "square");
  document.body.dataset.skin = skin.id;
  // 这种网格里还没有位置的组件（比如第一次用六边形主题），先占个位，下面统一找空位
  for (const item of lay.items) if (!cellOf(item)) setCell(item, { col: -99, row: -99 });
  for (const item of lay.items) {
    const l = mount(item);
    if (!l) continue;
    // 位置在这块屏幕上放不下（比如换了分辨率）：挪到最近的空位
    const c = cellOf(item)!;
    if (!fits(item.size, c, item.id)) {
      const o = c.col < 0 ? { x: 0, y: 0 } : grid().origin(item.size, c);
      setCell(item, { col: -99, row: -99 });
      const s = nearestFree(item.size, o.x, o.y, item.id);
      if (s) setCell(item, s);
      else {
        removeWidget(l);
        continue;
      }
      const p = grid().origin(item.size, s);
      l.x.value = l.x.target = p.x;
      l.y.value = l.y.target = p.y;
    }
  }
  applyFrame();
  reportHits();
  const editingNow = await invoke<boolean>("widgets_cmd", { action: "get" }).catch(() => false);
  if (editingNow) setEditing(true);
}

initTheme();
start();
