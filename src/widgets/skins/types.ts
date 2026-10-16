// 组件"主题"（形状和外观）的公共约定。
//
// 组件只负责数据和操作，主题负责"长什么样"：外框形状、描边发光，以及每种组件在这个主题下怎么排版。
// 每个主题是 skins/ 下的一个独立文件，默认导出一个 Skin；加新主题不用改组件。
// 颜色一律用 widgets.css 里的 --w-* 变量（跟着壁纸变），主题自己不写死颜色。

import type { SizeKey } from "../types";

// ---------------- 组件给主题的数据 ----------------

export interface ClockData {
  now: Date;
  seconds: boolean;
  hour12: boolean;
}

export type PomoPhase = "idle" | "running" | "paused" | "done";

export interface PomoData {
  phase: PomoPhase;
  totalMs: number;
  /** 还剩多少毫秒（运行中是此刻的值） */
  remainingMs: number;
}

export interface MusicData {
  active: boolean;
  title: string;
  /** 歌手；没有就是来源程序名 */
  artist: string;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  canToggle: boolean;
  canNext: boolean;
  canPrev: boolean;
  /** 封面 data URL，没有为空 */
  cover: string;
}

export interface StatusData {
  /** 0..100，还没读到为 null */
  cpu: number | null;
  gpuTemp: number | null;
  battery: { percent: number; charging: boolean; low: boolean } | null;
  /** 最近几十次 CPU 读数（画曲线用） */
  history: number[];
}

export interface AudioData {
  /** 64 个频段，0..255，低音在前 */
  bands: number[];
  /** 最近的波形，-127..127 */
  wave: number[];
  /** 整体响度 0..1 */
  level: number;
  /** 安静了一阵：淡出、停止绘制 */
  silent: boolean;
  /** 设置的帧率（60 / 30） */
  fps: number;
  /** 样式：频谱柱 / 波形 */
  style: "bars" | "wave";
  /** 指定的颜色（封面色 / 手动色）；为空就用壁纸的强调色 */
  color: [number, number, number] | null;
  /** 收到这一帧的时间（performance.now） */
  at: number;
}

/** 每种组件的数据类型；以后加组件就在这里加一行 */
export interface DataOf {
  clock: ClockData;
  pomodoro: PomoData;
  music: MusicData;
  status: StatusData;
  audio: AudioData;
}
export type Kind = keyof DataOf;

// ---------------- 主题 ----------------

/** 主题给某种组件画的一套界面 */
export interface View<D> {
  /** 数据变了。只改真正变了的地方 */
  update(d: D): void;
  destroy(): void;
}

export interface ViewCtx {
  size: SizeKey;
  /** 组件外框的大小（像素） */
  w: number;
  h: number;
  /** 组件的动作（番茄钟 start / pause，音乐 toggle …） */
  act(action: string): void;
}

export type ViewFactory<D> = (root: HTMLElement, ctx: ViewCtx) => View<D>;

/** 外框：形状、描边、角标、装饰动画都在这里 */
export interface Frame {
  /** 暂停装饰动画（全屏、看不见的时候） */
  setPaused(p: boolean): void;
  destroy(): void;
}

export type Pt = [number, number];

export interface Skin {
  id: string;
  name: string;
  /** 编辑模式吸附用哪种网格 */
  grid: "rect" | "hex";
  /** 在组件的外层元素上画外框（w×h 像素）；内容放进返回的 content 元素里 */
  frame(host: HTMLElement, size: SizeKey, w: number, h: number): { frame: Frame; content: HTMLElement };
  /** 形状的轮廓（相对外框左上角的像素点）：只有轮廓里面能点到，外面点击穿透 */
  outline(size: SizeKey, w: number, h: number): Pt[];
  /** 每种组件在这个主题下的界面；没写的组件用通用界面（views/ 下） */
  views: { [K in Kind]?: ViewFactory<DataOf[K]> };
}

// ---------------- 小工具 ----------------

export const WEEK = "日一二三四五六";
export const pad = (n: number) => String(n).padStart(2, "0");

export function timeText(d: Date, hour12: boolean) {
  let h = d.getHours();
  let ampm = "";
  if (hour12) {
    ampm = h < 12 ? "上午" : "下午";
    h = h % 12 || 12;
  }
  return { hm: `${hour12 ? h : pad(h)}:${pad(d.getMinutes())}`, sec: pad(d.getSeconds()), ampm };
}

export const dateText = (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日`;
export const weekText = (d: Date) => `星期${WEEK[d.getDay()]}`;

export function mmss(ms: number) {
  const s = Math.ceil(ms / 1000);
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

export function fmtPos(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** 只在内容真的变了时才写进页面 */
export function setter() {
  const last = new Map<Element, string>();
  return (el: Element | null, text: string) => {
    if (!el || last.get(el) === text) return;
    last.set(el, text);
    el.textContent = text;
  };
}

/** 只在值变了时才改属性 / 样式 */
export function attrSetter() {
  const last = new WeakMap<Element, Map<string, string>>();
  return (el: Element, name: string, value: string | number) => {
    let m = last.get(el);
    if (!m) last.set(el, (m = new Map()));
    const v = String(value);
    if (m.get(name) === v) return;
    m.set(name, v);
    // "--xxx" 和 "transform" 是样式，其余是属性
    if (name.startsWith("--") || name === "transform") (el as HTMLElement | SVGElement).style.setProperty(name, v);
    else el.setAttribute(name, v);
  };
}

/** 番茄钟的按钮：[文字, 动作] */
export const POMO_BUTTONS: Record<PomoPhase, [string, string][]> = {
  idle: [["开始", "start"]],
  running: [
    ["暂停", "pause"],
    ["结束", "cancel"],
  ],
  paused: [
    ["继续", "resume"],
    ["结束", "cancel"],
  ],
  done: [
    ["再来一轮", "start"],
    ["好的", "dismiss"],
  ],
};

export const POMO_LABEL: Record<PomoPhase, string> = {
  idle: "准备专注",
  running: "专注中",
  paused: "已暂停",
  done: "专注完成",
};

/** 番茄钟按钮：只在状态变了时重建 */
export function pomoButtons(box: HTMLElement, ctx: ViewCtx, cls: string, max = 2) {
  let phase: PomoPhase | null = null;
  return (p: PomoPhase, label?: (text: string) => string) => {
    if (p === phase) return;
    phase = p;
    box.replaceChildren();
    POMO_BUTTONS[p].slice(0, max).forEach(([text, action], i) => {
      const b = document.createElement("button");
      b.className = cls + (i === 0 ? " primary" : "");
      b.textContent = label ? label(text) : text;
      b.addEventListener("click", () => ctx.act(action));
      box.appendChild(b);
    });
  };
}

export const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M6 6l8.5 6L6 18zM16 6h2.2v12H16z"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M18 6l-8.5 6L18 18zM5.8 6H8v12H5.8z"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M9 17.5a2.5 2.5 0 1 1-2.5-2.5c.35 0 .69.07 1 .2V6l10-2v11.5a2.5 2.5 0 1 1-2.5-2.5c.35 0 .69.07 1 .2V7.2l-7 1.4z"/></svg>',
};

/** 音乐的三个按钮（上一首 / 播放暂停 / 下一首）：建一次，之后只改状态 */
export function musicButtons(box: HTMLElement, ctx: ViewCtx, cls: string, which: ("prev" | "toggle" | "next")[] = ["prev", "toggle", "next"]) {
  const btn: Partial<Record<"prev" | "toggle" | "next", HTMLButtonElement>> = {};
  for (const k of which) {
    const b = document.createElement("button");
    b.className = `${cls} b-${k}` + (k === "toggle" ? " main" : "");
    b.innerHTML = k === "toggle" ? ICON.play : ICON[k];
    b.addEventListener("click", () => ctx.act(k));
    box.appendChild(b);
    btn[k] = b;
  }
  let playing: boolean | null = null;
  return (d: MusicData) => {
    if (btn.toggle) {
      btn.toggle.disabled = !d.canToggle;
      if (playing !== d.playing) {
        playing = d.playing;
        btn.toggle.innerHTML = d.playing ? ICON.pause : ICON.play;
      }
    }
    if (btn.prev) btn.prev.disabled = !d.canPrev;
    if (btn.next) btn.next.disabled = !d.canNext;
  };
}

/** 封面：只在换图时才改 */
export function coverSetter(img: HTMLImageElement) {
  let last: string | null = null;
  return (url: string) => {
    if (url === last) return;
    last = url;
    if (url) img.src = url;
    else img.removeAttribute("src");
    img.hidden = !url;
  };
}

export function statusView(d: StatusData) {
  const cpu = d.cpu == null ? null : Math.round(d.cpu);
  const bat = d.battery;
  return {
    cpu: { text: cpu == null ? "—" : `${cpu}%`, frac: (cpu ?? 0) / 100, warn: (cpu ?? 0) >= 90, note: "", label: "CPU" },
    gpu: {
      text: d.gpuTemp == null ? "—" : `${d.gpuTemp}°`,
      // 30°C 到 95°C 映射到 0..1
      frac: d.gpuTemp == null ? 0 : Math.min(1, Math.max(0, (d.gpuTemp - 30) / 65)),
      warn: (d.gpuTemp ?? 0) >= 85,
      note: d.gpuTemp == null ? "未读取" : "",
      label: "显卡",
    },
    bat: {
      text: bat ? `${bat.percent}%` : "—",
      frac: bat ? bat.percent / 100 : 0,
      warn: !!bat?.low,
      note: bat ? (bat.charging ? "充电中" : "") : "无电池",
      label: "电量",
    },
  };
}
export const STATUS_KEYS = ["cpu", "gpu", "bat"] as const;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", parent?: Element) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.appendChild(e);
  return e;
}

export const SVG_NS = "http://www.w3.org/2000/svg";
export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

/** 圆 / 胶囊的轮廓（多边形近似，用来判断点击） */
export function roundOutline(w: number, h: number, n = 32): Pt[] {
  const r = Math.min(w, h) / 2;
  const pts: Pt[] = [];
  // 右半圆 + 左半圆，中间直线自然连起来；正圆时两个圆心重合
  const cxR = w - r;
  const cxL = r;
  for (let i = 0; i <= n / 2; i++) {
    const a = -Math.PI / 2 + (i / (n / 2)) * Math.PI;
    pts.push([cxR + Math.cos(a) * r, h / 2 + Math.sin(a) * r]);
  }
  for (let i = 0; i <= n / 2; i++) {
    const a = Math.PI / 2 + (i / (n / 2)) * Math.PI;
    pts.push([cxL + Math.cos(a) * r, h / 2 + Math.sin(a) * r]);
  }
  return pts;
}

/** 圆角矩形的轮廓 */
export function roundRectOutline(w: number, h: number, r: number): Pt[] {
  const pts: Pt[] = [];
  const corners: [number, number, number][] = [
    [w - r, r, -90],
    [w - r, h - r, 0],
    [r, h - r, 90],
    [r, r, 180],
  ];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= 4; i++) {
      const a = ((start + i * 22.5) * Math.PI) / 180;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  return pts;
}
