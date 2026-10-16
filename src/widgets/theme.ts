// 小组件颜色：收到 Rust 算好的一套颜色后，用弹簧在约 1 秒内平滑过渡过去，不突然跳变。
// 只有过渡期间跑动画循环，颜色定下来后不再重绘。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Animator, Spring } from "../spring";

type Rgba = [number, number, number, number];

interface Theme {
  bg: Rgba;
  text: Rgba;
  sub: Rgba;
  stroke: Rgba;
  accent: Rgba;
  onAccent: Rgba;
  dark: boolean;
  source: string;
  image: string;
}

const KEYS = ["bg", "text", "sub", "stroke", "accent", "onAccent"] as const;
type Key = (typeof KEYS)[number];
const CSS_VAR: Record<Key, string> = {
  // 底色写到 --w-bg-base；每个组件再按自己的"背景透明度"调淡成 --w-bg（见 widgets.css）
  bg: "--w-bg-base",
  text: "--w-text",
  sub: "--w-sub",
  stroke: "--w-stroke",
  accent: "--w-accent",
  onAccent: "--w-on-accent",
};

// 换壁纸时的颜色过渡：比界面动画慢一些、不回弹（临界阻尼），约 1 秒到位
const COLOR_SPRING = { stiffness: 36, damping: 12, precision: 0.002 };

let from: Record<Key, Rgba> | null = null;
let to: Record<Key, Rgba> | null = null;
const t = new Spring(1, COLOR_SPRING);
const anim = new Animator(apply);
anim.add(t);

const lerp = (a: Rgba, b: Rgba, k: number): Rgba => a.map((v, i) => v + (b[i] - v) * k) as Rgba;
const css = ([r, g, b, a]: Rgba) => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a.toFixed(3)})`;

function current(): Record<Key, Rgba> | null {
  if (!from || !to) return to;
  const k = Math.min(1, Math.max(0, t.value));
  return Object.fromEntries(KEYS.map((key) => [key, lerp(from![key], to![key], k)])) as Record<Key, Rgba>;
}

function apply() {
  const c = current();
  if (!c) return;
  const root = document.documentElement.style;
  for (const key of KEYS) root.setProperty(CSS_VAR[key], css(c[key]));
}

function setTheme(th: Theme, animate: boolean) {
  const next = Object.fromEntries(KEYS.map((k) => [k, th[k]])) as Record<Key, Rgba>;
  document.documentElement.dataset.theme = th.dark ? "dark" : "light";
  if (!animate || !to) {
    from = null;
    to = next;
    apply();
    return;
  }
  // 从"现在看到的颜色"出发，过渡途中又换壁纸也不会跳
  from = current();
  to = next;
  t.value = 0;
  t.velocity = 0;
  t.target = 1;
  anim.kick();
}

export function initTheme() {
  invoke<Theme | null>("widgets_theme_get")
    .then((th) => th && setTheme(th, false))
    .catch(() => {});
  listen<Theme>("widgets-theme", (e) => setTheme(e.payload, true));
}
