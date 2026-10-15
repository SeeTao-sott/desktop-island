import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Animator, Spring } from "./spring";

// 胶囊的两种形态（CSS 像素）。窗口本身固定大小，形变只在页面里做
const TOP = 8;
const COMPACT = { w: 120, h: 34, r: 17 };
const EXPANDED = { w: 340, h: 96, r: 30 };
// 鼠标判定区比胶囊略大一点，边缘不至于来回抖
const HIT_PAD = 4;
// 移开后稍等再收回，防止擦边划过时闪一下
const COLLAPSE_DELAY = 120;

const island = document.getElementById("island")!;
const compactLayer = island.querySelector<HTMLElement>(".compact")!;
const expandedLayer = island.querySelector<HTMLElement>(".expanded")!;
const fpsEl = document.getElementById("fps")!;

// 形状弹簧带一点回弹；内容淡入淡出稍快、阻尼更大，避免文字晃
const shape = { stiffness: 420, damping: 28, precision: 0.05 };
const content = { stiffness: 520, damping: 40, precision: 0.002 };

const animator = new Animator(render, reportFps);
const w = animator.add(new Spring(COMPACT.w, shape));
const h = animator.add(new Spring(COMPACT.h, shape));
const r = animator.add(new Spring(COMPACT.r, shape));
const p = animator.add(new Spring(0, content));

function render() {
  const x = (window.innerWidth - w.value) / 2;
  island.style.transform = `translate3d(${x}px, ${TOP}px, 0)`;
  island.style.width = `${w.value}px`;
  island.style.height = `${h.value}px`;
  island.style.borderRadius = `${r.value}px`;

  const t = Math.min(Math.max(p.value, 0), 1);
  compactLayer.style.opacity = String(1 - t * 1.6 < 0 ? 0 : 1 - t * 1.6);
  compactLayer.style.transform = `scale(${1 - t * 0.08})`;
  expandedLayer.style.opacity = String(Math.max(0, t * 1.4 - 0.4));
  expandedLayer.style.transform = `translate3d(0, ${(1 - t) * -6}px, 0) scale(${0.94 + t * 0.06})`;
}

let expanded = false;
let collapseTimer: number | undefined;

function setExpanded(next: boolean) {
  if (next === expanded) return;
  expanded = next;
  const s = next ? EXPANDED : COMPACT;
  w.target = s.w;
  h.target = s.h;
  r.target = s.r;
  p.target = next ? 1 : 0;
  sendHitRect(s);
  animator.kick();
}

// 告诉 Rust 哪一块区域算"在胶囊上"，用目标形态而不是动画中途的形态
function sendHitRect(s: { w: number; h: number }) {
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
const timeCompact = document.getElementById("time-compact")!;
const timeBig = document.getElementById("time-big")!;
const dateEl = document.getElementById("date")!;

function updateClock() {
  const d = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  timeCompact.textContent = hm;
  timeBig.textContent = hm;
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
render();
sendHitRect(COMPACT);
window.addEventListener("resize", () => {
  render();
  sendHitRect(expanded ? EXPANDED : COMPACT);
});
