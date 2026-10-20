// 裂缝射击：准星和设置面板。
// 准星照 Valorant 的"内侧线"画：四条短线围着中心，可调颜色、长度、粗细、间隙、描边、中心点。
// 设置、模式、最高分存在配置文件夹的 rift.json 里（loadStore / saveStore）。
import { invoke } from "@tauri-apps/api/core";

export interface AimSettings {
  /** Valorant 灵敏度：每个鼠标移动单位转 0.07 × 灵敏度 度 */
  sens: number;
  color: string;
  /** 每条线的长度、粗细、离中心的间隙（像素） */
  length: number;
  thick: number;
  gap: number;
  outline: boolean;
  dot: boolean;
  /** 靶墙几列（4~9） */
  cols: number;
  /** 裂缝最多开到几行（1~4） */
  rows: number;
  /** 镜头离靶墙多远（1 = 默认，越大靶墙在屏幕上越小、越集中） */
  zoom: number;
  /** 靶子大小倍数 */
  size: number;
  /** 靶子提前多少秒出现 */
  lead: number;
  /** 裂缝最大时占屏幕高度的比例 */
  maxFrac: number;
  /** 水平视野（度） */
  fov: number;
  /** 判定窗口：拍点前后多少毫秒内算 Great（Perfect 是它的一半） */
  window: number;
  /** 同一时刻的一对靶子，晚打的那个额外多给多少毫秒 */
  pairGrace: number;
  /** 裂缝变大变小时："follow" 靶子跟着上下移动（各行一直居中）、"fixed" 靶子不动（裂缝自己挪一点） */
  rowMode: string;
  /** 行的布局变了（裂缝变大变小）时，视角自动跟着挪，准星一直停在原来瞄着的那一格上 */
  aimFollow: boolean;
  /** 裂缝里的场景："range" 靶场、"sky" 天空之岛 */
  scene: string;
  /** 裂缝边飘出的粒子、裂缝里的浮尘 */
  particles: boolean;
  /** 裂缝边的样子："tear" 撕裂（大锯齿、发亮的撕口）、"crack" 裂纹（折线 + 分叉、双色光焰和电弧）、"classic" 经典（一条发光边） */
  riftStyle: string;
  /** 裂缝边特效（光焰流动、电弧、抖动）的速度倍数 */
  fxSpeed: number;
  /** 沿着裂缝边跳动的电弧 */
  arcs: boolean;
  /** 配色："pair" 经典撞色（主题色 + 按经典配色表找的搭档色）、"mono" 单色（原来的样子） */
  colorMode: string;
  /** 自动模式：准星自己转去瞄最近的靶子、在拍点开枪（看谱、找感觉用；这一局不记最高分） */
  auto: boolean;
}

export const RIFT_STYLES: [string, string][] = [
  ["tear", "撕裂"],
  ["crack", "裂纹"],
  ["classic", "经典"],
];

export const SCENES: [string, string][] = [
  ["range", "靶场"],
  ["sky", "天空之岛"],
];

export const DEFAULTS: AimSettings = { sens: 0.4, color: "#00ffb4", length: 6, thick: 2, gap: 3, outline: true, dot: false, cols: 6, rows: 4, zoom: 1, size: 1, lead: 1, maxFrac: 0.6, fov: 103, window: 100, pairGrace: 150, rowMode: "follow", aimFollow: true, scene: "range", particles: true, riftStyle: "tear", fxSpeed: 0.5, arcs: false, colorMode: "pair", auto: false };
const KEY = "rift-aim";

/** 跟着"模式"走的设置；其余（灵敏度、准星、裂缝高度、视野）所有模式共用 */
export const MODE_KEYS = ["cols", "rows", "zoom", "size", "lead", "window", "pairGrace", "rowMode", "aimFollow"] as const;
type ModeKey = (typeof MODE_KEYS)[number];
export interface Mode {
  name: string;
  v: Pick<AimSettings, ModeKey>;
}

/** 存在 rift.json 里的全部东西 */
export interface RiftStore {
  settings: AimSettings;
  modes: Mode[];
  /** 当前用哪个模式（modes 的下标） */
  active: number;
  /** 最高分：按"歌 | 难度"记 */
  best: Record<string, number>;
}

const pickMode = (s: AimSettings): Mode["v"] => Object.fromEntries(MODE_KEYS.map((k) => [k, s[k]])) as Mode["v"];

/** 把明显不合理的值拉回范围 */
export function cleanSettings(raw: unknown): AimSettings {
  try {
    const s = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) } as AimSettings;
    s.cols = Math.min(9, Math.max(4, Math.round(Number(s.cols) || DEFAULTS.cols)));
    s.rows = Math.min(4, Math.max(1, Math.round(Number(s.rows) || DEFAULTS.rows)));
    s.zoom = Math.min(2.5, Math.max(1, Number(s.zoom) || DEFAULTS.zoom));
    s.size = Math.min(1.6, Math.max(0.5, Number(s.size) || DEFAULTS.size));
    s.lead = Math.min(2, Math.max(0.5, Number(s.lead) || DEFAULTS.lead));
    s.maxFrac = Math.min(0.8, Math.max(0.3, Number(s.maxFrac) || DEFAULTS.maxFrac));
    s.fov = Math.min(120, Math.max(70, Number(s.fov) || DEFAULTS.fov));
    s.window = Math.min(250, Math.max(60, Number(s.window) || DEFAULTS.window));
    s.pairGrace = Math.min(500, Math.max(0, Number.isFinite(Number(s.pairGrace)) ? Number(s.pairGrace) : DEFAULTS.pairGrace));
    if (!SCENES.some(([k]) => k === s.scene)) s.scene = DEFAULTS.scene;
    if (s.rowMode !== "fixed") s.rowMode = "follow";
    s.aimFollow = s.aimFollow !== false;
    s.particles = s.particles !== false;
    if (!RIFT_STYLES.some(([k]) => k === s.riftStyle)) s.riftStyle = DEFAULTS.riftStyle;
    s.fxSpeed = Math.min(2, Math.max(0.1, Number(s.fxSpeed) || DEFAULTS.fxSpeed));
    s.arcs = s.arcs === true;
    s.auto = s.auto === true;
    if (s.colorMode !== "mono") s.colorMode = "pair";
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

function readLocal<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

/** 读文件；文件还没有时，把以前存在 localStorage 里的设置和最高分搬过来 */
export async function loadStore(): Promise<RiftStore> {
  let raw: Partial<RiftStore> | null = null;
  try {
    raw = await invoke<Partial<RiftStore> | null>("rift_store_get");
  } catch {
    // 读不了就当没有
  }
  if (!raw || typeof raw !== "object") {
    raw = { settings: readLocal(KEY) ?? undefined, best: readLocal("rift-best") ?? undefined };
  }
  const settings = cleanSettings(raw.settings);
  let modes = Array.isArray(raw.modes)
    ? raw.modes
        .filter((m) => m && typeof m === "object")
        .map((m, i) => ({ name: String(m.name || `模式 ${i + 1}`), v: pickMode(cleanSettings({ ...settings, ...m.v })) }))
    : [];
  if (!modes.length) modes = [{ name: "模式 1", v: pickMode(settings) }];
  const active = Math.min(modes.length - 1, Math.max(0, Math.round(Number(raw.active) || 0)));
  Object.assign(settings, modes[active].v);
  const best = raw.best && typeof raw.best === "object" ? raw.best : {};
  return { settings, modes, active, best };
}

let saveTimer = 0;
let pending: RiftStore | null = null;
/** 存盘：连着改的时候停一下手再写（数字框每敲一个字都会触发） */
export function saveStore(st: RiftStore) {
  // 当前模式的值跟着设置走
  st.modes[st.active].v = pickMode(st.settings);
  pending = st;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushStore, 300);
}

/** 马上写盘（关窗口前调） */
export async function flushStore() {
  window.clearTimeout(saveTimer);
  const st = pending;
  pending = null;
  if (!st) return;
  try {
    await invoke("rift_store_set", { data: st });
  } catch {
    // 存不了就算了，这次照样能用
  }
}

/** 按设置重画准星（el 固定在屏幕正中） */
export function drawCrosshair(el: HTMLElement, s: AimSettings) {
  el.replaceChildren();
  const shadow = s.outline ? "0 0 0 1px rgba(0, 0, 0, 0.6)" : "none";
  const bar = (x: number, y: number, w: number, h: number) => {
    const d = document.createElement("i");
    d.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:${s.color};box-shadow:${shadow}`;
    el.appendChild(d);
  };
  const t = s.thick;
  const half = t / 2;
  // 上下左右四条，从间隙往外伸 length
  bar(-half, -s.gap - s.length, t, s.length);
  bar(-half, s.gap, t, s.length);
  bar(-s.gap - s.length, -half, s.length, t);
  bar(s.gap, -half, s.length, t);
  if (s.dot) bar(-half, -half, t, t);
}

/** 设置分三页；记住上次停在哪一页（只是本机的小方便，存不了也没关系） */
const TABS: [string, string][] = [
  ["play", "玩法"],
  ["aim", "瞄准"],
  ["look", "画面"],
];
const TAB_KEY = "rift-settings-tab";
let currentTab = (() => {
  try {
    const t = localStorage.getItem(TAB_KEY);
    return TABS.some(([k]) => k === t) ? t! : "play";
  } catch {
    return "play";
  }
})();

/** 设置面板：改了就立刻生效并保存。分「玩法 / 瞄准 / 画面」三页；玩法页最上面是模式：切换、新建、改名、删除 */
export function buildSettings(panel: HTMLElement, store: RiftStore, onChange: (s: AimSettings) => void) {
  panel.replaceChildren();
  const s = store.settings;
  const rebuild = () => buildSettings(panel, store, onChange);
  // 标签页按钮 + 每页一个容器；下面的 row() 加到"当前在写的那一页"
  const tabBar = document.createElement("div");
  tabBar.className = "rf-tabs";
  panel.appendChild(tabBar);
  const pages = new Map<string, HTMLElement>();
  for (const [key, label] of TABS) {
    const page = document.createElement("div");
    page.className = "rf-page";
    page.hidden = key !== currentTab;
    pages.set(key, page);
    panel.appendChild(page);
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.classList.toggle("on", key === currentTab);
    b.addEventListener("click", () => {
      currentTab = key;
      try {
        localStorage.setItem(TAB_KEY, key);
      } catch {
        // 记不住就算了
      }
      for (const [k, pg] of pages) pg.hidden = k !== key;
      tabBar.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    });
    tabBar.appendChild(b);
  }
  let target = pages.get("play")!;
  const page = (key: string) => (target = pages.get(key)!);
  const row = (label: string, input: HTMLElement, note?: string) => {
    const r = document.createElement("label");
    r.className = "rf-row";
    const name = document.createElement("span");
    name.textContent = label;
    r.append(name, input);
    if (note) {
      const n = document.createElement("small");
      n.textContent = note;
      r.appendChild(n);
    }
    target.appendChild(r);
  };
  const num = (
    key: "sens" | "length" | "thick" | "gap" | "cols" | "rows" | "zoom" | "size" | "lead" | "maxFrac" | "fov" | "window" | "pairGrace" | "fxSpeed",
    min: number,
    max: number,
    step: number,
  ) => {
    const i = document.createElement("input");
    i.type = "number";
    i.min = String(min);
    i.max = String(max);
    i.step = String(step);
    i.value = String(s[key]);
    i.addEventListener("input", () => {
      const v = Number(i.value);
      if (!Number.isFinite(v)) return;
      s[key] = Math.min(max, Math.max(min, step >= 1 ? Math.round(v) : v));
      onChange(s);
    });
    return i;
  };
  const check = (key: "outline" | "dot" | "particles" | "arcs" | "aimFollow" | "auto") => {
    const i = document.createElement("input");
    i.type = "checkbox";
    i.checked = s[key];
    i.addEventListener("change", () => {
      s[key] = i.checked;
      onChange(s);
    });
    return i;
  };
  const color = document.createElement("input");
  color.type = "color";
  color.value = s.color;
  color.addEventListener("input", () => {
    s.color = color.value;
    onChange(s);
  });
  // ---- 模式 ----
  const modeBar = document.createElement("div");
  modeBar.className = "rf-modes";
  const sel = document.createElement("select");
  store.modes.forEach((m, i) => sel.add(new Option(m.name, String(i), false, i === store.active)));
  sel.addEventListener("change", () => {
    store.active = Number(sel.value);
    Object.assign(s, store.modes[store.active].v);
    onChange(s);
    rebuild();
  });
  const btn = (text: string, title: string, fn: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = title;
    b.addEventListener("click", fn);
    return b;
  };
  const add = btn("新建", "用现在的设置新建一个模式", () => {
    let n = store.modes.length + 1;
    while (store.modes.some((m) => m.name === `模式 ${n}`)) n++;
    store.modes.push({ name: `模式 ${n}`, v: pickMode(s) });
    store.active = store.modes.length - 1;
    onChange(s);
    rebuild();
  });
  const del = btn("删除", "删除这个模式", () => {
    if (store.modes.length <= 1) return;
    store.modes.splice(store.active, 1);
    store.active = Math.max(0, store.active - 1);
    Object.assign(s, store.modes[store.active].v);
    onChange(s);
    rebuild();
  });
  del.disabled = store.modes.length <= 1;
  modeBar.append(sel, add, del);
  page("play");
  row("模式", modeBar, "这一页带 ◆ 的几项每个模式各存一份，改了自动记到当前模式里");
  const name = document.createElement("input");
  name.type = "text";
  name.maxLength = 20;
  name.value = store.modes[store.active].name;
  name.addEventListener("input", () => {
    const t = name.value.trim() || `模式 ${store.active + 1}`;
    store.modes[store.active].name = t;
    sel.options[store.active].text = t;
    onChange(s);
  });
  row("模式名字", name);
  const autoBox = check("auto");
  autoBox.id = "rf-auto"; // 游戏里按 F2 开关时同步这个勾
  row("自动模式", autoBox, "准星自己转去瞄靶子、在拍点开枪（金色组用右键整组打）；开着时鼠标不起作用，这一局不记最高分。游戏中按 F2 也能开关");

  row("◆ 靶墙列数", num("cols", 4, 9, 1), "4~9 列；红靶在左半边，蓝靶在右半边");
  row("◆ 最多几行", num("rows", 1, 4, 1), "1~4 行；高潮时裂缝最多开到这么多行");
  row("◆ 镜头距离", num("zoom", 1, 2.5, 0.1), "1~2.5 倍；越大靶墙越小、越集中在准星附近");
  row("◆ 靶子大小", num("size", 0.5, 1.6, 0.1), "0.5~1.6 倍");
  row("◆ 出现提前量（秒）", num("lead", 0.5, 2, 0.1), "靶子提前多久出现、外圈收多久");
  row("◆ 判定窗口（ms）", num("window", 60, 250, 10), "拍点前后多少毫秒内算 Great，Perfect 是它的一半");
  row("◆ 同时靶子宽限（ms）", num("pairGrace", 0, 500, 10), "同时出现的两个靶子，晚打的那个多给这么久");
  const rowSel = document.createElement("select");
  for (const [k, label] of [
    ["follow", "跟着裂缝移动"],
    ["fixed", "固定不动"],
  ])
    rowSel.add(new Option(label, k, false, k === s.rowMode));
  rowSel.addEventListener("change", () => {
    s.rowMode = rowSel.value;
    onChange(s);
  });
  row("◆ 靶子位置", rowSel, "裂缝变大变小时：跟着移动 = 各行一直居中、靶子会上下挪；固定不动 = 整面靶墙一起平移，靶子之间不相对滑动");
  row("◆ 准星跟着格子", check("aimFollow"), "行的位置变了时视角自动跟着挪，准星一直停在原来瞄着的那一格；那一行收起来了就停在最近的一行");
  page("look");
  row("裂缝最大高度", num("maxFrac", 0.3, 0.8, 0.05), "占屏幕高度的比例；改了会重新打开一下");
  row("视野 FOV", num("fov", 70, 120, 1), "水平视野（度），Valorant 是 103；改了会重新打开一下");
  const sceneSel = document.createElement("select");
  for (const [k, label] of SCENES) sceneSel.add(new Option(label, k, false, k === s.scene));
  sceneSel.addEventListener("change", () => {
    s.scene = sceneSel.value;
    onChange(s);
  });
  row("场景", sceneSel, "裂缝里的环境；改了会重新打开一下");
  const styleSel = document.createElement("select");
  for (const [k, label] of RIFT_STYLES) styleSel.add(new Option(label, k, false, k === s.riftStyle));
  styleSel.addEventListener("change", () => {
    s.riftStyle = styleSel.value;
    onChange(s);
  });
  row("裂缝样式", styleSel, "撕裂：大锯齿、发亮的撕口；裂纹：主裂缝裂出几道窄而曲折的分支、带光焰；经典：一条整齐的发光边");
  row("边缘电弧", check("arcs"), "沿着裂缝边一段一段跳动的电弧（三种样式都能开）");
  const colorSel = document.createElement("select");
  for (const [k, label] of [
    ["pair", "经典撞色"],
    ["mono", "单色"],
  ])
    colorSel.add(new Option(label, k, false, k === s.colorMode));
  colorSel.addEventListener("change", () => {
    s.colorMode = colorSel.value;
    onChange(s);
  });
  row("配色", colorSel, "经典撞色：按壁纸主色找经典搭档色（红配蓝、橙配青、黄配紫……），裂缝里的场景、格子、靶子都换成它（红色壁纸 → 蓝色靶场），裂缝外圈、一部分火星也用它；单色：全用壁纸主色");
  row("裂缝特效速度", num("fxSpeed", 0.1, 2, 0.1), "光焰流动、电弧、边缘抖动的快慢（1 = 原速）");
  row("粒子效果", check("particles"), "裂缝边飘出的火星、裂缝里的浮尘；掉帧可以关掉");
  page("aim");
  row("灵敏度（Valorant）", num("sens", 0.01, 10, 0.001), "和 Valorant 里填一样的数，转动角度相同");
  row("准星颜色", color);
  row("线长", num("length", 0, 20, 1));
  row("粗细", num("thick", 1, 10, 1));
  row("间隙", num("gap", 0, 20, 1));
  row("描边", check("outline"));
  row("中心点", check("dot"));
}
