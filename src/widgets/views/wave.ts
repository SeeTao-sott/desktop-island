// 上下对称的竖柱：以中线为轴，每根柱子同时往上、往下伸。两种数据来源：
//   - 波形（wave）：系统声音的时域采样，每根柱子 = 那一小段声音的实时起伏（|平均值|），每帧都跟着声音变
//   - 对称频谱（sym）：和频谱柱一样来自频段强度，低音在正中间，往左右两边依次是中音、高音（左右镜像）
//
// 高度只来自数据，绝不乘任何固定形状。两端"淡出"只影响颜色的透明度（横向渐变），不影响高度。
// 圆环主题下：从圆周同时往外、往里伸出短柱；对称频谱时低音在最上方，往两侧到最下方是高音。
//
// 柱子之间留缝；每根柱子后面垫一层更宽、半透明的柱子当发光（不用模糊滤镜）；每根柱子自己平滑，不抖。
import type { AudioData } from "../skins/types";
import type { Layout, Renderer, Rgb } from "./audio";

const RISE = 22;
const FALL = 9;
/** Rust 发来的波形点数 */
const N_WAVE = 128;
/** 一圈时每边的柱子数（两边对称） */
const RING_HALF = 36;

const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;
/** 和白色混一点：柱子本身偏亮，发光层用原色 */
const lighten = ([r, g, b]: Rgb, k: number): Rgb => [r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k];

/** src[0..len) 按段取最大值，压成 out 的长度 */
function regroup(src: ArrayLike<number>, len: number, out: Float32Array, scale: number, abs: boolean) {
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * len) / n);
    const z = Math.max(a + 1, Math.floor(((i + 1) * len) / n));
    let m = 0;
    for (let k = a; k < z; k++) m = Math.max(m, abs ? Math.abs(src[k]) : src[k]);
    out[i] = m / scale;
  }
}

function mirrorRenderer(layout: Layout, source: "wave" | "sym"): Renderer {
  const ring = layout === "ring";
  let W = 0;
  let H = 0;
  /** 柱子总数（一排时）；值数组：波形时一根一个值，对称频谱时左右共用（只存一半） */
  let cols = 0;
  let cur = new Float32Array(0);
  let target = new Float32Array(0);
  let color: Rgb = [140, 170, 255];
  let body: CanvasGradient | string = "";
  let glow: CanvasGradient | string = "";
  let line: CanvasGradient | string = "";
  let dirty = true;

  /** 需要几个值：一圈时每边 RING_HALF 个（两边镜像）；一排对称频谱时只要一半（左右镜像）；一排波形时每根一个 */
  const valueCount = () => (ring ? RING_HALF : source === "sym" ? Math.ceil(cols / 2) : cols);

  /** 一排时第 i 根柱子用哪个值 */
  const valueOf = (i: number) => {
    if (source === "wave") return cur[i];
    // 对称频谱：正中间是低音（第 0 个值），往两边越来越高
    const half = cols / 2;
    const k = i < half ? Math.floor(half - 1 - i) : Math.floor(i - half);
    return cur[Math.min(cur.length - 1, Math.max(0, k))];
  };

  return {
    resize(w, h) {
      W = w;
      H = h;
      // 柱子数量：一排时按宽度，每根约 7 像素（对称频谱取偶数，左右刚好对称）
      let c = Math.max(14, Math.min(72, Math.floor(w / 7)));
      if (source === "sym" && c % 2) c -= 1;
      cols = c;
      const k = valueCount();
      if (k !== cur.length) {
        cur = new Float32Array(k);
        target = new Float32Array(k);
      }
      dirty = true;
    },
    setColor(c) {
      color = c;
      dirty = true;
    },
    feed(d: AudioData) {
      if (source === "wave") {
        if (d.wave.length !== N_WAVE) return;
        // 每根柱子 = 一小段声音的起伏大小；音量已经在 Rust 里自动增益过
        regroup(d.wave, N_WAVE, target, 127, true);
      } else {
        if (!d.bands.length) return;
        // 64 个频段（低音在前）压成需要的个数，每个取段内最大
        regroup(d.bands, d.bands.length, target, 255, false);
      }
    },
    quiet() {
      target.fill(0);
    },
    step(dt) {
      let moving = false;
      for (let i = 0; i < cur.length; i++) {
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
      // 横向渐变：只改透明度——两端透明，中间最亮（高度不受影响）
      const mk = (c: Rgb, a: number) => {
        const gr = g.createLinearGradient(0, 0, W, 0);
        gr.addColorStop(0, rgba(c, a * 0.15));
        gr.addColorStop(0.25, rgba(c, a * 0.7));
        gr.addColorStop(0.5, rgba(c, a));
        gr.addColorStop(0.75, rgba(c, a * 0.7));
        gr.addColorStop(1, rgba(c, a * 0.15));
        return gr;
      };
      body = mk(lighten(color, 0.35), 1);
      glow = mk(color, 0.3);
      line = mk(color, 0.35);
    }
    const padX = Math.max(8, W * 0.04);
    const mid = H / 2;
    const maxA = H * 0.44;
    const slot = (W - padX * 2) / cols;
    const bw = Math.max(1.5, slot * 0.5);
    const rad = Math.min(bw / 2, 2);
    const h = (i: number) => Math.max(1, valueOf(i) * maxA);
    // 中线
    g.fillStyle = line;
    g.fillRect(padX, mid - 0.5, W - padX * 2, 1);
    // 发光层：宽一点、半透明
    g.fillStyle = glow;
    for (let i = 0; i < cols; i++) {
      const x = padX + i * slot + (slot - bw) / 2;
      const hh = h(i);
      g.fillRect(x - 1.5, mid - hh - 1.5, bw + 3, hh * 2 + 3);
    }
    // 柱子：以中线为轴上下对称
    g.fillStyle = body;
    g.beginPath();
    for (let i = 0; i < cols; i++) {
      const x = padX + i * slot + (slot - bw) / 2;
      const hh = h(i);
      g.roundRect(x, mid - hh, bw, hh * 2, rad);
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
    const n = cur.length;
    const bw = Math.max(1.5, ((Math.PI * 2 * r0) / (n * 2)) * 0.5);
    const path = () => {
      g.beginPath();
      for (let k = 0; k < n; k++) {
        const len = Math.max(1, cur[k] * amp);
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

/** 波形：系统声音的实时起伏 */
export const waveRenderer = (layout: Layout) => mirrorRenderer(layout, "wave");
/** 对称频谱：低音在中间，往两边是高音 */
export const symRenderer = (layout: Layout) => mirrorRenderer(layout, "sym");
