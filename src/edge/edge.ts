// 屏幕边缘律动：一个铺满屏幕、永远点不到（鼠标穿过去）的置顶透明窗口，只在四条边上画光带，
// 跟着系统正在放的声音变粗变亮：低音推上下两条，中音推左右两条。颜色跟壁纸的主题色。
// 没声音时淡出，并告诉 Rust 把窗口藏起来（不留一个看不见的置顶窗口挡着全屏程序）。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { initTheme } from "../widgets/theme";

interface Frame {
  bands: number[];
  level: number;
  silent: boolean;
}

const top = document.querySelector<HTMLElement>(".top")!;
const bottom = document.querySelector<HTMLElement>(".bottom")!;
const left = document.querySelector<HTMLElement>(".left")!;
const right = document.querySelector<HTMLElement>(".right")!;

let enabled = false;
let watching = false;
/** 平滑后的强度（0~1）：上来快、下去慢，像呼吸一样 */
let bass = 0;
let mid = 0;
let alpha = 0;
let shown = false;
let fadeTimer = 0;

function watch(on: boolean) {
  if (on === watching) return;
  watching = on;
  invoke("audio_watch", { on, fps: 60 }).catch(() => {});
}

function setShown(on: boolean) {
  if (on === shown) return;
  shown = on;
  invoke("edge_active", { on }).catch(() => {});
}

const avg = (a: number[], from: number, to: number) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] ?? 0;
  return s / Math.max(1, to - from) / 255;
};
const follow = (cur: number, target: number) => cur + (target - cur) * (target > cur ? 0.55 : 0.12);

function draw() {
  const b = 0.25 + bass * 0.95;
  const m = 0.25 + mid * 0.95;
  top.style.transform = bottom.style.transform = `scaleY(${b.toFixed(3)})`;
  left.style.transform = right.style.transform = `scaleX(${m.toFixed(3)})`;
  const ob = (alpha * (0.35 + bass * 0.65)).toFixed(3);
  const om = (alpha * (0.35 + mid * 0.65)).toFixed(3);
  top.style.opacity = bottom.style.opacity = ob;
  left.style.opacity = right.style.opacity = om;
}

// 静音后慢慢淡出（不靠 requestAnimationFrame：窗口藏起来时它会停）
function fadeOut() {
  window.clearInterval(fadeTimer);
  fadeTimer = window.setInterval(() => {
    alpha = Math.max(0, alpha - 0.06);
    bass = follow(bass, 0);
    mid = follow(mid, 0);
    draw();
    if (alpha <= 0) {
      window.clearInterval(fadeTimer);
      setShown(false);
    }
  }, 33);
}

listen<Frame>("audio-frame", (e) => {
  if (!enabled) return;
  const f = e.payload;
  if (f.silent) {
    fadeOut();
    return;
  }
  window.clearInterval(fadeTimer);
  setShown(true);
  // 低音 40~250Hz 大约是前 35 个频段，中音 250Hz~2kHz 大约是 35~80
  bass = follow(bass, Math.min(1, avg(f.bands, 0, 35) * 1.15));
  mid = follow(mid, Math.min(1, avg(f.bands, 35, 80) * 1.25));
  alpha = Math.min(1, alpha + 0.12);
  draw();
});

/** 托盘里开着没有；玩裂缝射击时临时停掉（保证游戏帧数），玩完恢复 */
let userEnabled = false;
let riftOn = false;
function apply() {
  const on = userEnabled && !riftOn;
  enabled = on;
  watch(on);
  if (!on) fadeOut();
}
function setEnabled(on: boolean) {
  userEnabled = on;
  apply();
}
listen<boolean>("rift-active", (e) => {
  riftOn = e.payload;
  apply();
});

listen<boolean>("edge-enabled", (e) => setEnabled(e.payload));
invoke<boolean>("edge_enabled")
  .then(setEnabled)
  .catch(() => {});
initTheme();
