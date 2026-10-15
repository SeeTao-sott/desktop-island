import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface MediaInfo {
  active: boolean;
  title: string;
  artist: string;
  source: string;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  canToggle: boolean;
  canNext: boolean;
  canPrev: boolean;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const covers = document.querySelectorAll<HTMLImageElement>(".js-cover");
const island = $("#island");
const track = $(".js-track");
const titleEl = $(".js-title");
const artistEl = $(".js-artist");
const bar = $(".js-bar");
const fill = $(".js-fill");
const elapsedEl = $(".js-elapsed");
const totalEl = $(".js-total");
const btnToggle = $<HTMLButtonElement>(".js-toggle");
const btnNext = $<HTMLButtonElement>(".js-next");
const btnPrev = $<HTMLButtonElement>(".js-prev");

let info: MediaInfo | null = null;
let receivedAt = 0; // 收到 info 时的 performance.now()
let expanded = false;
let tickTimer: number | undefined;
let onShapeChange: () => void = () => {};

export const musicActive = () => !!info?.active;

function fmt(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m % 60).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function positionNow() {
  if (!info) return 0;
  const p = info.positionMs + (info.playing ? performance.now() - receivedAt : 0);
  return Math.min(Math.max(p, 0), info.durationMs);
}

// 进度条：一次性交给 CSS 线性过渡到结尾，由合成器负责，JS 不需要每帧干活
function syncProgress() {
  window.clearInterval(tickTimer);
  const hasTimeline = !!info && info.durationMs > 0;
  bar.style.visibility = hasTimeline ? "visible" : "hidden";
  elapsedEl.textContent = hasTimeline ? fmt(positionNow()) : "";
  totalEl.textContent = hasTimeline ? fmt(info!.durationMs) : "";
  if (!hasTimeline) return;

  const f = positionNow() / info!.durationMs;
  fill.style.transition = "none";
  fill.style.transform = `scaleX(${f})`;
  // 只有展开、并且正在播放时才让它动起来；收起时不产生任何绘制
  if (!expanded || !info!.playing) return;
  void fill.offsetWidth; // 让上面的起点先生效
  const remaining = info!.durationMs - positionNow();
  fill.style.transition = `transform ${remaining}ms linear`;
  fill.style.transform = "scaleX(1)";
  tickTimer = window.setInterval(() => (elapsedEl.textContent = fmt(positionNow())), 1000);
}

function applyInfo(next: MediaInfo) {
  const prev = info;
  const wasActive = !!prev?.active;
  const trackChanged = !prev || prev.title !== next.title || prev.artist !== next.artist;
  info = next;
  receivedAt = performance.now();

  titleEl.textContent = next.title;
  artistEl.textContent = next.artist || sourceName(next.source);
  island.classList.toggle("playing", next.playing);
  btnToggle.disabled = !next.canToggle;
  btnNext.disabled = !next.canNext;
  btnPrev.disabled = !next.canPrev;

  // 切歌：标题区做一个小的上浮淡入（只动 transform/opacity）
  if (trackChanged && wasActive && next.active && expanded) {
    track.animate(
      [
        { opacity: 0, transform: "translate3d(0, 8px, 0)" },
        { opacity: 1, transform: "translate3d(0, 0, 0)" },
      ],
      { duration: 320, easing: "cubic-bezier(0.2, 1.3, 0.4, 1)" },
    );
  }

  syncProgress();
  if (wasActive !== next.active) onShapeChange();
}

// 没有歌手时显示来源程序，比如 "Chrome"
function sourceName(id: string) {
  const base = id.split("!").pop()!.split("\\").pop()!.replace(/\.exe$/i, "");
  return base.replace(/^electron\.app\./, "");
}

function setCover(url: string) {
  covers.forEach((img) => {
    if (url) img.src = url;
    else img.removeAttribute("src");
    img.classList.toggle("empty", !url);
  });
}

export function onExpandChange(next: boolean) {
  expanded = next;
  // 展开时让 Rust 重新读一次，拿到最新进度
  if (next && info?.active) invoke("media_cmd", { action: "refresh" }).catch(() => {});
  syncProgress();
}

function press(action: "toggle" | "next" | "prev") {
  invoke("media_cmd", { action }).catch(() => {});
  // 播放/暂停先在界面上切换，系统确认后会再推一次真实状态
  if (action === "toggle" && info) {
    applyInfo({ ...info, positionMs: positionNow(), playing: !info.playing });
  }
}

export function initMusic(shapeChanged: () => void) {
  onShapeChange = shapeChanged;
  setCover("");
  btnToggle.addEventListener("click", () => press("toggle"));
  btnNext.addEventListener("click", () => press("next"));
  btnPrev.addEventListener("click", () => press("prev"));
  // 监听注册好之后再让 Rust 把当前状态推一遍，避免错过启动时的第一条
  Promise.all([
    listen<MediaInfo>("media", (e) => applyInfo(e.payload)),
    listen<string>("media-cover", (e) => setCover(e.payload)),
  ]).then(() => invoke("media_cmd", { action: "sync" }).catch(() => {}));
}
