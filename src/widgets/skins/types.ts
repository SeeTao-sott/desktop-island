// 组件"主题"（形状和外观）的公共约定。
//
// 组件只负责数据和操作（现在几点、番茄钟还剩多少、按了哪个按钮），
// 主题负责"长什么样"：外框形状、描边发光，以及每种组件在这个主题下怎么排版。
// 每个主题是 skins/ 下的一个独立文件，默认导出一个 Skin；加新主题不用改组件。
//
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

/** 番茄钟的按钮：[文字, 动作]，主题只管摆放，点了调用 act(动作) */
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

/** 每种组件的数据类型；以后加组件就在这里加一行 */
export interface DataOf {
  clock: ClockData;
  pomodoro: PomoData;
}
export type Kind = keyof DataOf;

// ---------------- 主题 ----------------

/** 主题给某种组件画的一套界面 */
export interface View<D> {
  /** 数据变了（时钟每秒 / 每分钟，番茄钟每秒）。只改真正变了的地方 */
  update(d: D): void;
  destroy(): void;
}

export interface ViewCtx {
  size: SizeKey;
  /** 组件的动作（番茄钟的 start / pause …） */
  act(action: string): void;
}

export type ViewFactory<D> = (root: HTMLElement, ctx: ViewCtx) => View<D>;

/** 外框：形状、描边、角标、装饰动画都在这里 */
export interface Frame {
  /** 暂停装饰动画（全屏、看不见的时候） */
  setPaused(p: boolean): void;
  destroy(): void;
}

export interface Skin {
  id: string;
  name: string;
  /** 在组件的外层元素上画外框；内容放进返回的 content 元素里 */
  frame(host: HTMLElement, size: SizeKey): { frame: Frame; content: HTMLElement };
  /** 某种组件的专属界面；没有的就用 fallback（放在外框里的普通排版） */
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

/** 只在文字真的变了时才写进页面 */
export function setter() {
  const last = new Map<Element, string>();
  return (el: Element | null, text: string) => {
    if (!el || last.get(el) === text) return;
    last.set(el, text);
    el.textContent = text;
  };
}

/** 番茄钟按钮：只在状态变了时重建 */
export function pomoButtons(box: HTMLElement, ctx: ViewCtx, cls: string, max = 2) {
  let phase: PomoPhase | null = null;
  return (p: PomoPhase, label?: (text: string) => string) => {
    if (p === phase) return;
    phase = p;
    box.replaceChildren();
    const list = POMO_BUTTONS[p].slice(0, max);
    list.forEach(([text, action], i) => {
      const b = document.createElement("button");
      b.className = cls + (i === 0 ? " primary" : "");
      b.textContent = label ? label(text) : text;
      b.addEventListener("click", () => ctx.act(action));
      box.appendChild(b);
    });
  };
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", parent?: HTMLElement) {
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
