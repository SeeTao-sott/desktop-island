// 频谱柱：一个 canvas 画完所有柱子（不用一堆 DOM 元素）。
//   - 升起快、落下慢：每根柱子自己平滑，看起来顺滑不抖
//   - 柔和发光：每根柱子后面先画一层更宽、半透明的同色柱（不用 shadowBlur，便宜得多）
//   - 倒影：基线下方镜像一份，往下渐渐淡掉
//   - 每收到一帧数据画一次（最多 60 / 30 帧，不跟着 144Hz 屏幕空转）；
//     没声音后只把柱子落完、淡出完，然后完全停下，不再重绘
//   - 颜色、渐变缓存起来，只在主题颜色或尺寸变了时重建
import type { AudioData, View, ViewCtx } from "../skins/types";

/** 升起速度系数：大约 40 毫秒追上 */
const RISE = 28;
/** 每秒落下多少（满高的比例）：从满到底约 0.9 秒 */
const FALL = 1.1;
/** 淡入淡出速度（每秒） */
const FADE_IN = 4;
const FADE_OUT = 1.2;
/** 超过这么久没收到新帧，当作没声音 */
const STALE_MS = 400;

/** "rgba(213, 71, 245, 1)" / "rgb(…)" → [r, g, b] */
function parseRgb(s: string): [number, number, number] | null {
  const m = s.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}
const rgba = ([r, g, b]: [number, number, number], a: number) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;

export function spectrumView(root: HTMLElement, ctx: ViewCtx): View<AudioData> {
  root.className = `viz viz-bars size-${ctx.size}`;
  const canvas = document.createElement("canvas");
  root.appendChild(canvas);
  const g = canvas.getContext("2d")!;

  let bars = 0;
  let cur = new Float32Array(0);
  let target = new Float32Array(0);
  let data: AudioData | null = null;
  let fade = 0;
  let lastT = 0;
  let rafPending = false;
  let idleTimer = 0;
  let W = 0;
  let H = 0;
  let dpr = 1;

  // 缓存的颜色和渐变
  let accentKey = "";
  let color: [number, number, number] = [140, 170, 255];
  let body: CanvasGradient | null = null;
  let refl: CanvasGradient | null = null;
  let glow = "";

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = root.clientWidth;
    H = root.clientHeight;
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    // 柱子数量：按宽度来，每根约 7 像素
    const n = Math.max(12, Math.min(64, Math.floor(W / 7)));
    if (n !== bars) {
      bars = n;
      cur = new Float32Array(n);
      target = new Float32Array(n);
    }
    body = null; // 尺寸变了，渐变重建
    draw();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(root);

  /** 主题颜色变了才重建颜色和渐变 */
  function refreshColors() {
    const a = getComputedStyle(root).getPropertyValue("--w-accent").trim();
    if (a === accentKey && body) return;
    accentKey = a;
    color = parseRgb(a) ?? color;
    const base = H * 0.7;
    body = g.createLinearGradient(0, H * 0.1, 0, base);
    body.addColorStop(0, rgba(color, 1));
    body.addColorStop(1, rgba(color, 0.55));
    refl = g.createLinearGradient(0, base, 0, H);
    refl.addColorStop(0, rgba(color, 0.32));
    refl.addColorStop(1, rgba(color, 0));
    glow = rgba(color, 0.22);
  }

  /** 64 个频段合成 bars 根柱子（每根取段内最大值） */
  function regroup(bands: number[]) {
    const n = bands.length;
    for (let i = 0; i < bars; i++) {
      const a = Math.floor((i * n) / bars);
      const z = Math.max(a + 1, Math.floor(((i + 1) * n) / bars));
      let m = 0;
      for (let k = a; k < z; k++) m = Math.max(m, bands[k]);
      target[i] = m / 255;
    }
  }

  /** 排一帧（和屏幕刷新对齐）；已经排了就不重复 */
  function kick() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(step);
  }

  function step(t: number) {
    rafPending = false;
    window.clearTimeout(idleTimer);
    const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 1 / 60;
    lastT = t;

    const stale = !data || data.silent || t - data.at > STALE_MS;
    if (stale) target.fill(0);
    fade = stale ? Math.max(0, fade - FADE_OUT * dt) : Math.min(1, fade + FADE_IN * dt);

    let moving = false;
    for (let i = 0; i < bars; i++) {
      const v = cur[i];
      const tv = target[i];
      cur[i] = tv > v ? v + (tv - v) * Math.min(1, RISE * dt) : Math.max(tv, v - FALL * dt);
      if (cur[i] > 0.002) moving = true;
    }
    draw();

    if (!stale) return; // 有声音：下一帧等下一批数据来了再画
    if (fade <= 0 && !moving) {
      lastT = 0; // 完全安静：停下，一帧都不再画
      return;
    }
    // 没有新数据了但还在落下 / 淡出：按设置的帧率自己排下一帧
    idleTimer = window.setTimeout(kick, 1000 / (data?.fps ?? 60));
  }

  function draw() {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (fade <= 0 || bars === 0) return;
    refreshColors();
    const padX = Math.max(10, W * 0.05);
    const base = H * 0.7; // 基线：上面是柱子，下面是倒影
    const maxH = base - H * 0.1;
    const slot = (W - padX * 2) / bars;
    const bw = Math.max(2, slot * 0.62);
    const r = Math.min(2, bw / 2);
    g.globalAlpha = fade;

    // 先把三层各自一次画完，减少换颜色的次数
    g.fillStyle = glow;
    for (let i = 0; i < bars; i++) {
      const h = Math.max(1.5, cur[i] * maxH);
      g.fillRect(padX + i * slot + (slot - bw) / 2 - 2, base - h - 2, bw + 4, h + 2);
    }
    g.fillStyle = body!;
    g.beginPath();
    for (let i = 0; i < bars; i++) {
      const h = Math.max(1.5, cur[i] * maxH);
      g.roundRect(padX + i * slot + (slot - bw) / 2, base - h, bw, h, [r, r, 0, 0]);
    }
    g.fill();
    g.fillStyle = refl!;
    for (let i = 0; i < bars; i++) {
      const h = Math.max(1.5, cur[i] * maxH);
      g.fillRect(padX + i * slot + (slot - bw) / 2, base + 2, bw, h * 0.5);
    }
    g.globalAlpha = 1;
  }

  resize();

  return {
    update(d) {
      data = d;
      if (!d.silent && d.bands.length) regroup(d.bands);
      kick();
    },
    destroy() {
      window.clearTimeout(idleTimer);
      ro.disconnect();
      root.replaceChildren();
    },
  };
}
