// 波形：把声音的实时波形画成一根根竖柱，以中线为轴上下对称（像示波器的包络）。
//   - 一排时：中间的柱子高、往两端收矮，颜色也往两端淡出
//   - 一圈时：从圆周同时往外、往里伸出短柱，最上和最下收短、两侧最长
//   - 柱子之间留缝，能清楚看出一根一根；每根柱子后面垫一层更宽、半透明的柱子当发光（不用模糊滤镜）
//   - 每根柱子自己平滑（涨得快、落得稍慢），不抖
import type { AudioData } from "../skins/types";
import type { Layout, Renderer, Rgb } from "./audio";

const RISE = 22;
const FALL = 9;
/** Rust 发来的波形点数 */
const N = 128;
/** 一圈时每边的柱子数（两边对称） */
const RING_HALF = 36;

const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;
/** 和白色混一点：柱子本身偏亮，发光层用原色 */
const lighten = ([r, g, b]: Rgb, k: number): Rgb => [r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k];

export function waveRenderer(layout: Layout): Renderer {
  const ring = layout === "ring";
  let W = 0;
  let H = 0;
  let n = 0;
  let cur = new Float32Array(0);
  let target = new Float32Array(0);
  /** 两头收矮的包络 */
  let taper = new Float32Array(0);
  let color: Rgb = [140, 170, 255];
  let body: CanvasGradient | string = "";
  let glow: CanvasGradient | string = "";
  let line: CanvasGradient | string = "";
  let dirty = true;

  return {
    resize(w, h) {
      W = w;
      H = h;
      // 柱子数量：一排时按宽度，每根约 7 像素；一圈时每边固定 36 根
      const k = ring ? RING_HALF : Math.max(14, Math.min(72, Math.floor(w / 7)));
      if (k !== n) {
        n = k;
        cur = new Float32Array(n);
        target = new Float32Array(n);
        taper = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          // 一排：中间 1、两端约 0.15；一圈：k 从上到下，两侧（中间那段）最长
          taper[i] = 0.15 + 0.85 * Math.pow(Math.sin((Math.PI * (i + 0.5)) / n), 1.4);
        }
      }
      dirty = true;
    },
    setColor(c) {
      color = c;
      dirty = true;
    },
    feed(d: AudioData) {
      if (d.wave.length !== N) return;
      // 128 个点合成 n 根柱子（每根取段内最大的振幅）；音量已经在 Rust 里自动增益过
      for (let i = 0; i < n; i++) {
        const a = Math.floor((i * N) / n);
        const z = Math.max(a + 1, Math.floor(((i + 1) * N) / n));
        let m = 0;
        for (let k = a; k < z; k++) m = Math.max(m, Math.abs(d.wave[k]));
        // 开 0.85 次方：小声的地方也看得见，又不会把高低差抹平
        target[i] = Math.pow(m / 127, 0.85);
      }
    },
    quiet() {
      target.fill(0);
    },
    step(dt) {
      let moving = false;
      for (let i = 0; i < n; i++) {
        const v = cur[i];
        const tv = target[i];
        cur[i] = v + (tv - v) * Math.min(1, (tv > v ? RISE : FALL) * dt);
        if (cur[i] > 0.003) moving = true;
      }
      return moving;
    },
    draw(g) {
      if (ring) drawRing(g);
      else drawLine(g);
    },
  };

  function drawLine(g: CanvasRenderingContext2D) {
    if (dirty) {
      dirty = false;
      // 横向渐变：两端透明，中间最亮
      const mk = (c: Rgb, a: number) => {
        const gr = g.createLinearGradient(0, 0, W, 0);
        gr.addColorStop(0, rgba(c, 0));
        gr.addColorStop(0.25, rgba(c, a * 0.65));
        gr.addColorStop(0.5, rgba(c, a));
        gr.addColorStop(0.75, rgba(c, a * 0.65));
        gr.addColorStop(1, rgba(c, 0));
        return gr;
      };
      body = mk(lighten(color, 0.35), 1);
      glow = mk(color, 0.3);
      line = mk(color, 0.35);
    }
    const padX = Math.max(8, W * 0.04);
    const mid = H / 2;
    const maxA = H * 0.44;
    const slot = (W - padX * 2) / n;
    const bw = Math.max(1.5, slot * 0.5);
    const rad = Math.min(bw / 2, 2);
    const h = (i: number) => Math.max(1, cur[i] * taper[i] * maxA);
    // 中线
    g.fillStyle = line;
    g.fillRect(padX, mid - 0.5, W - padX * 2, 1);
    // 发光层：宽一点、半透明
    g.fillStyle = glow;
    for (let i = 0; i < n; i++) {
      const x = padX + i * slot + (slot - bw) / 2;
      g.fillRect(x - 1.5, mid - h(i) - 1.5, bw + 3, h(i) * 2 + 3);
    }
    // 柱子：以中线为轴上下对称
    g.fillStyle = body;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const x = padX + i * slot + (slot - bw) / 2;
      g.roundRect(x, mid - h(i), bw, h(i) * 2, rad);
    }
    g.fill();
  }

  function drawRing(g: CanvasRenderingContext2D) {
    const R = (Math.min(W, H) / 2) * 0.94;
    const cx = W / 2;
    const cy = H / 2;
    const r0 = R * 0.62;
    const amp = R * 0.34;
    if (dirty) {
      dirty = false;
      body = rgba(lighten(color, 0.35), 0.95);
      glow = rgba(color, 0.28);
      line = rgba(color, 0.3);
    }
    const bw = Math.max(1.5, ((Math.PI * 2 * r0) / (n * 2)) * 0.5);
    const path = () => {
      g.beginPath();
      for (let k = 0; k < n; k++) {
        const len = Math.max(1, cur[k] * taper[k] * amp);
        for (const side of [1, -1]) {
          const a = -Math.PI / 2 + side * ((k + 0.5) / n) * Math.PI;
          const [dx, dy] = [Math.cos(a), Math.sin(a)];
          // 往外伸 len，往里伸 0.6 倍
          g.moveTo(cx + dx * (r0 - len * 0.6), cy + dy * (r0 - len * 0.6));
          g.lineTo(cx + dx * (r0 + len), cy + dy * (r0 + len));
        }
      }
    };
    // 圆周
    g.beginPath();
    g.arc(cx, cy, r0, 0, Math.PI * 2);
    g.strokeStyle = line;
    g.lineWidth = 1;
    g.stroke();
    g.lineCap = "round";
    path();
    g.strokeStyle = glow;
    g.lineWidth = bw + 3;
    g.stroke();
    g.strokeStyle = body;
    g.lineWidth = bw;
    g.stroke();
  }
}
