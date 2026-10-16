// 桌面小组件的主页面：摆放、编辑模式（拖动 + 吸附网格 + 换尺寸）、保存布局、点击区域上报。
// 所有位置、尺寸、编辑模式的出现消失都走灵动岛同一套弹簧；静止时不跑动画循环。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Animator, Spring } from "../spring";
import { SPRING, fpsReporter } from "../motion";
import { MODULES, moduleOf } from "./registry";
import {
  MARGIN,
  SIZES,
  STEP,
  settingsWithDefaults,
  spanPx,
  type Settings,
  type SizeKey,
  type WidgetInstance,
  type WidgetModule,
} from "./types";

interface Item {
  id: string;
  kind: string;
  size: SizeKey;
  col: number;
  row: number;
  settings: Settings;
}

interface Layout {
  version: 1;
  items: Item[];
}

interface Live {
  item: Item;
  mod: WidgetModule;
  el: HTMLElement;
  body: HTMLElement;
  content: HTMLElement;
  chips: HTMLElement;
  panel: HTMLElement | null;
  inst: WidgetInstance;
  x: Spring;
  y: Spring;
  w: Spring;
  h: Spring;
  s: Spring;
}

const board = document.getElementById("board")!;
const backdrop = document.getElementById("backdrop")!;
const slot = document.getElementById("slot")!;
const editBar = document.getElementById("edit-bar")!;
const fpsEl = document.getElementById("fps")!;

const live: Live[] = [];
let editing = false;
let paused = false;

const editFade = new Spring(0, SPRING.fade);
const animator = new Animator(applyFrame, (frames) => {
  fpsReporter(fpsEl)(frames);
  if (!editing) reportHits();
});
animator.add(editFade);

// ---------------- 网格 ----------------

const cols = () => Math.max(2, Math.floor((window.innerWidth - 2 * MARGIN + (STEP - spanPx(1))) / STEP));
const rows = () => Math.max(2, Math.floor((window.innerHeight - 2 * MARGIN + (STEP - spanPx(1))) / STEP));
const colPx = (c: number) => MARGIN + c * STEP;

function fits(size: SizeKey, col: number, row: number, exceptId: string | null) {
  const { cols: w, rows: h } = SIZES[size];
  if (col < 0 || row < 0 || col + w > cols() || row + h > rows()) return false;
  return live.every(({ item: o }) => {
    if (o.id === exceptId) return true;
    const os = SIZES[o.size];
    return col + w <= o.col || o.col + os.cols <= col || row + h <= o.row || o.row + os.rows <= row;
  });
}

/** 离 (col,row) 最近的空位；整块屏幕都放不下就返回 null */
function nearestFree(size: SizeKey, col: number, row: number, exceptId: string | null) {
  let best: { col: number; row: number } | null = null;
  let bestD = Infinity;
  for (let r = 0; r < rows(); r++) {
    for (let c = 0; c < cols(); c++) {
      const d = (c - col) ** 2 + (r - row) ** 2;
      if (d < bestD && fits(size, c, r, exceptId)) {
        bestD = d;
        best = { col: c, row: r };
      }
    }
  }
  return best;
}

// ---------------- 组件的创建和动画 ----------------

const GEAR =
  '<svg viewBox="0 0 24 24"><path d="M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zm8.6 2.3l-1.9-.4a7 7 0 0 0-.7-1.6l1.1-1.6-1.6-1.6-1.6 1.1a7 7 0 0 0-1.6-.7l-.4-1.9h-2.2l-.4 1.9a7 7 0 0 0-1.6.7L6.1 5.6 4.5 7.2l1.1 1.6a7 7 0 0 0-.7 1.6l-1.9.4v2.2l1.9.4c.2.6.4 1.1.7 1.6l-1.1 1.6 1.6 1.6 1.6-1.1c.5.3 1 .5 1.6.7l.4 1.9h2.2l.4-1.9a7 7 0 0 0 1.6-.7l1.6 1.1 1.6-1.6-1.1-1.6c.3-.5.5-1 .7-1.6l1.9-.4z"/></svg>';

function mount(item: Item): Live | null {
  const mod = moduleOf(item.kind);
  if (!mod) return null;
  if (!mod.sizes.includes(item.size)) item.size = mod.defaultSize;
  item.settings = settingsWithDefaults(mod, item.settings ?? {});

  const el = document.createElement("div");
  el.className = "widget";
  el.dataset.kind = mod.kind;
  const body = document.createElement("div");
  body.className = "widget-body";
  const content = document.createElement("div");
  content.className = "widget-content";
  content.style.height = "100%";
  body.appendChild(content);
  const ring = document.createElement("div");
  ring.className = "edit-ring";
  const chips = document.createElement("div");
  chips.className = "edit-chips glass";
  el.append(body, ring, chips);
  board.appendChild(el);

  const inst = mod.create(content, { size: item.size, settings: item.settings });
  const x = colPx(item.col);
  const y = colPx(item.row);
  const w = spanPx(SIZES[item.size].cols);
  const h = spanPx(SIZES[item.size].rows);
  const l: Live = {
    item,
    mod,
    el,
    body,
    content,
    chips,
    panel: null,
    inst,
    x: animator.add(new Spring(x, SPRING.shape)),
    y: animator.add(new Spring(y, SPRING.shape)),
    w: animator.add(new Spring(w, SPRING.shape)),
    h: animator.add(new Spring(h, SPRING.shape)),
    s: animator.add(new Spring(1, SPRING.shape)),
  };
  buildChips(l);
  bindDrag(l);
  live.push(l);
  if (paused) inst.setPaused(true);
  return l;
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
  for (const d of l.mod.settings ?? []) {
    const lab = document.createElement("label");
    lab.textContent = d.label;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = l.item.settings[d.key] === true;
    input.addEventListener("change", () => {
      l.item.settings = { ...l.item.settings, [d.key]: input.checked };
      l.inst.setSettings?.(l.item.settings);
    });
    lab.appendChild(input);
    p.appendChild(lab);
  }
  // 设置面板里的点击不当作拖动
  p.addEventListener("pointerdown", (e) => e.stopPropagation());
  l.body.appendChild(p);
  l.panel = p;
}

function closeAllSettings() {
  for (const l of live) {
    l.panel?.remove();
    l.panel = null;
  }
}

function resize(l: Live, size: SizeKey) {
  if (size === l.item.size) return;
  // 原位放得下就原位，放不下找最近的空位；哪里都放不下就不换
  const spot = fits(size, l.item.col, l.item.row, l.item.id)
    ? { col: l.item.col, row: l.item.row }
    : nearestFree(size, l.item.col, l.item.row, l.item.id);
  if (!spot) return;
  l.item.size = size;
  l.item.col = spot.col;
  l.item.row = spot.row;
  l.inst.setSize(size);
  buildChips(l);
  settle(l);
}

/** 弹回网格上的位置 */
function settle(l: Live) {
  l.x.target = colPx(l.item.col);
  l.y.target = colPx(l.item.row);
  l.w.target = spanPx(SIZES[l.item.size].cols);
  l.h.target = spanPx(SIZES[l.item.size].rows);
  l.s.target = 1;
  animator.kick();
}

function applyFrame() {
  const e = editFade.value;
  backdrop.style.opacity = String(e);
  document.body.style.setProperty("--edit", String(e));
  editBar.style.opacity = String(e);
  editBar.style.transform = `translate(-50%, ${(1 - e) * -12}px)`;
  for (const l of live) {
    l.el.style.width = `${l.w.value}px`;
    l.el.style.height = `${l.h.value}px`;
    l.el.style.transform = `translate(${l.x.value}px, ${l.y.value}px) scale(${l.s.value})`;
  }
}

// ---------------- 拖动 ----------------

function bindDrag(l: Live) {
  l.el.addEventListener("pointerdown", (e) => {
    if (!editing || e.button !== 0 || (e.target as HTMLElement).closest(".edit-chips")) return;
    e.preventDefault();
    closeAllSettings();
    l.el.setPointerCapture(e.pointerId);
    l.el.classList.add("dragging");
    const offX = e.clientX - l.x.value;
    const offY = e.clientY - l.y.value;
    l.s.target = 1.04;
    let spot = { col: l.item.col, row: l.item.row };
    showSlot(l.item.size, spot);

    const move = (ev: PointerEvent) => {
      l.x.target = ev.clientX - offX;
      l.y.target = ev.clientY - offY;
      // 松手会落在哪：最接近的格子；被占了就找附近的空位
      const c = Math.round((l.x.target - MARGIN) / STEP);
      const r = Math.round((l.y.target - MARGIN) / STEP);
      const s = fits(l.item.size, c, r, l.item.id) ? { col: c, row: r } : nearestFree(l.item.size, c, r, l.item.id);
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
      l.item.col = spot.col;
      l.item.row = spot.row;
      settle(l);
    };
    l.el.addEventListener("pointermove", move);
    l.el.addEventListener("pointerup", up);
    l.el.addEventListener("pointercancel", up);
    animator.kick();
  });
}

function showSlot(size: SizeKey, spot: { col: number; row: number }) {
  slot.hidden = false;
  slot.style.width = `${spanPx(SIZES[size].cols)}px`;
  slot.style.height = `${spanPx(SIZES[size].rows)}px`;
  slot.style.transform = `translate(${colPx(spot.col)}px, ${colPx(spot.row)}px)`;
}

// ---------------- 编辑模式、保存、点击区域 ----------------

function setEditing(on: boolean) {
  if (on === editing) return;
  editing = on;
  document.body.classList.toggle("editing", on);
  editFade.target = on ? 1 : 0;
  if (!on) {
    closeAllSettings();
    save();
  }
  animator.kick();
}

function layout(): Layout {
  return { version: 1, items: live.map((l) => ({ ...l.item })) };
}

async function save() {
  try {
    await invoke("widgets_layout_save", { layout: layout() });
  } catch (e) {
    console.error(e);
  }
}

/** 告诉 Rust 组件都在哪：鼠标在这些地方才接收点击，其余地方点击穿透 */
function reportHits() {
  const rects = live.map((l) => ({ x: l.x.target, y: l.y.target, w: l.w.target, h: l.h.target }));
  invoke("widgets_set_hits", { rects }).catch(() => {});
}

document.querySelector(".js-done")!.addEventListener("click", () => {
  invoke("widgets_cmd", { action: "edit-off" }).catch(() => {});
});

listen<boolean>("widgets-edit", (e) => setEditing(e.payload));
listen<boolean>("widgets-paused", (e) => {
  paused = e.payload;
  for (const l of live) l.inst.setPaused(paused);
});

// 屏幕大小变了：放不下的组件挪到最近的空位
window.addEventListener("resize", () => {
  for (const l of live) {
    if (!fits(l.item.size, l.item.col, l.item.row, l.item.id)) {
      const s = nearestFree(l.item.size, l.item.col, l.item.row, l.item.id);
      if (s) Object.assign(l.item, s);
    }
    settle(l);
  }
});

// ---------------- 启动 ----------------

function defaultLayout(): Layout {
  const clock = MODULES.find((m) => m.kind === "clock");
  return {
    version: 1,
    items: clock ? [{ id: "clock-1", kind: "clock", size: "medium", col: 0, row: 0, settings: {} }] : [],
  };
}

async function start() {
  let saved: Layout | null = null;
  try {
    saved = await invoke<Layout | null>("widgets_layout_get");
  } catch {
    saved = null;
  }
  const lay = saved && Array.isArray(saved.items) ? saved : defaultLayout();
  for (const item of lay.items) {
    const l = mount(item);
    if (!l) continue;
    // 布局文件里的位置在这块屏幕上放不下（比如换了分辨率）：挪到最近的空位
    if (!fits(item.size, item.col, item.row, item.id)) {
      const s = nearestFree(item.size, item.col, item.row, item.id);
      if (s) Object.assign(item, s);
      else {
        l.inst.destroy();
        l.el.remove();
        live.splice(live.indexOf(l), 1);
        continue;
      }
      settle(l);
    }
  }
  applyFrame();
  reportHits();
  const editingNow = await invoke<boolean>("widgets_cmd", { action: "get" }).catch(() => false);
  if (editingNow) setEditing(true);
}

start();
