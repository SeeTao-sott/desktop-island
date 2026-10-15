import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Animator, Spring } from "./spring";
import { initMusic, musicActive, onExpandChange } from "./music";

// 胶囊的几种形态（CSS 像素）。窗口本身固定大小，形变只在页面里做
type Shape = { w: number; h: number; r: number };
const TOP = 8;
const SHAPES = {
  compact: { w: 120, h: 34, r: 17 },
  compactMusic: { w: 168, h: 34, r: 17 },
  expanded: { w: 340, h: 96, r: 30 },
  expandedMusic: { w: 384, h: 124, r: 32 },
} satisfies Record<string, Shape>;
// 鼠标判定区比胶囊略大一点，边缘不至于来回抖
const HIT_PAD = 4;
// 移开后稍等再收回，防止擦边划过时闪一下
const COLLAPSE_DELAY = 120;

const island = document.getElementById("island")!;
const layers = {
  cTime: island.querySelector<HTMLElement>(".c-time")!,
  cMusic: island.querySelector<HTMLElement>(".c-music")!,
  eTime: island.querySelector<HTMLElement>(".e-time")!,
  eMusic: island.querySelector<HTMLElement>(".e-music")!,
};
const fpsEl = document.getElementById("fps")!;

// 形状弹簧带一点回弹；内容淡入淡出阻尼更大，避免文字晃
const shapeCfg = { stiffness: 420, damping: 28, precision: 0.05 };
const fadeCfg = { stiffness: 520, damping: 40, precision: 0.002 };

const animator = new Animator(render, reportFps);
const w = animator.add(new Spring(SHAPES.compact.w, shapeCfg));
const h = animator.add(new Spring(SHAPES.compact.h, shapeCfg));
const r = animator.add(new Spring(SHAPES.compact.r, shapeCfg));
const pExpand = animator.add(new Spring(0, fadeCfg)); // 0 收起 → 1 展开
const pMusic = animator.add(new Spring(0, fadeCfg)); // 0 时间 → 1 音乐

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

function setLayer(el: HTMLElement, alpha: number, transform: string) {
  // 几乎看不见的层直接隐藏，省掉绘制，也不挡按钮
  const visible = alpha > 0.01;
  el.style.visibility = visible ? "visible" : "hidden";
  if (!visible) return;
  el.style.opacity = String(alpha);
  el.style.transform = transform;
}

function render() {
  const x = (window.innerWidth - w.value) / 2;
  island.style.transform = `translate3d(${x}px, ${TOP}px, 0)`;
  island.style.width = `${w.value}px`;
  island.style.height = `${h.value}px`;
  island.style.borderRadius = `${r.value}px`;

  const e = clamp01(pExpand.value);
  const m = clamp01(pMusic.value);
  // 收起层比展开层先消失，展开层稍晚出现，避免两层内容叠在一起
  const cAlpha = clamp01(1 - e * 1.6);
  const eAlpha = clamp01(e * 1.4 - 0.4);
  const cScale = `scale(${1 - e * 0.08})`;
  const eMove = `translate3d(0, ${(1 - e) * -6}px, 0) scale(${0.94 + e * 0.06})`;

  setLayer(layers.cTime, cAlpha * (1 - m), cScale);
  setLayer(layers.cMusic, cAlpha * m, cScale);
  setLayer(layers.eTime, eAlpha * (1 - m), eMove);
  setLayer(layers.eMusic, eAlpha * m, eMove);
}

let expanded = false;
let collapseTimer: number | undefined;

function currentShape(): Shape {
  const music = musicActive();
  if (expanded) return music ? SHAPES.expandedMusic : SHAPES.expanded;
  return music ? SHAPES.compactMusic : SHAPES.compact;
}

// 任何状态变化都走这里：定下目标形态，弹簧自己追过去
function retarget() {
  const s = currentShape();
  w.target = s.w;
  h.target = s.h;
  r.target = s.r;
  pExpand.target = expanded ? 1 : 0;
  pMusic.target = musicActive() ? 1 : 0;
  sendHitRect(s);
  animator.kick();
}

function setExpanded(next: boolean) {
  if (next === expanded) return;
  expanded = next;
  onExpandChange(next);
  retarget();
}

// 告诉 Rust 哪一块区域算"在胶囊上"，用目标形态而不是动画中途的形态
function sendHitRect(s: Shape) {
  const rect = {
    x: (window.innerWidth - s.w) / 2 - HIT_PAD,
    y: TOP - HIT_PAD,
    w: s.w + HIT_PAD * 2,
    h: s.h + HIT_PAD * 2,
  };
  invoke("set_hit_rect", { rect }).catch(() => {});
}

listen<boolean>("island-hover", (e) => {
  window.clearTimeout(collapseTimer);
  if (e.payload) setExpanded(true);
  else collapseTimer = window.setTimeout(() => setExpanded(false), COLLAPSE_DELAY);
});

// ---------- 时钟：只在整分钟时更新一次 ----------
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const timeEls = document.querySelectorAll<HTMLElement>(".js-time");
const dateEl = document.querySelector<HTMLElement>(".js-date")!;

function updateClock() {
  const d = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  timeEls.forEach((el) => (el.textContent = hm));
  dateEl.textContent = `${d.getMonth() + 1}月${d.getDate()}日 星期${WEEK[d.getDay()]}`;
  const msToNextMinute = 60_000 - (d.getSeconds() * 1000 + d.getMilliseconds()) + 30;
  window.setTimeout(updateClock, msToNextMinute);
}

// ---------- 开发用 FPS：只统计动画期间的帧，不额外占用空闲 ----------
function reportFps(frames: number[]) {
  if (!import.meta.env.DEV || frames.length < 3) return;
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
  const worst = Math.max(...frames);
  fpsEl.hidden = false;
  fpsEl.textContent = `动画 ${Math.round(1000 / avg)} fps · 最慢一帧 ${worst.toFixed(1)}ms · ${frames.length} 帧`;
}

updateClock();
initMusic(retarget);
render();
sendHitRect(currentShape());
window.addEventListener("resize", () => {
  render();
  sendHitRect(currentShape());
});
