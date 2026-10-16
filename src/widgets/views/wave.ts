// 波形：像示波器一样画声音的实时波形，上下对称；圆环主题下变成一圈"呼吸"的环。
//   - 一排时：中间亮、往左右两端逐渐淡出，形状两头收窄
//   - 一圈时：左右对称，最上和最下收窄、两侧最宽
//   - 中间再叠一层更亮、更窄的"芯"，看起来是从中心发光
//   - 发光：沿轮廓画一圈更粗、半透明的线（不用模糊滤镜）
//   - 每个点自己平滑（涨得快、落得稍慢），不抖
import type { AudioData } from "../skins/types";
import type { Layout, Renderer, Rgb } from "./audio";

const RISE = 22;
const FALL = 9;
const N = 128;

const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;
/** 和白色混一点，做"芯"的颜色 */
const lighten = ([r, g, b]: Rgb, k: number): Rgb => [r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k];

export function waveRenderer(layout: Layout): Renderer {
  const ring = layout === "ring";
  let W = 0;
  let H = 0;
  const cur = new Float32Array(N);
  const target = new Float32Array(N);
  /** 两头收窄的包络 */
  const taper = new Float32Array(N);
  for (let i = 0; i < N; i++) taper[i] = Math.pow(Math.sin((Math.PI * (i + 0.5)) / N), 0.9);
  let color: Rgb = [140, 170, 255];
  let fillStyle: CanvasGradient | string = "";
  let coreStyle: CanvasGradient | string = "";
  let glowStyle: CanvasGradient | string = "";
  let lineStyle: CanvasGradient | string = "";
  let dirty = true;

  /** 一排：沿上边走、再沿下边回来的对称轮廓；k 是振幅缩放 */
  function lineOutline(g: CanvasRenderingContext2D, k: number) {
    const padX = Math.max(8, W * 0.03);
    const mid = H / 2;
    const maxA = H * 0.44 * k;
    const step = (W - padX * 2) / (N - 1);
    const y = (i: number) => cur[i] * taper[i] * maxA;
    g.beginPath();
    g.moveTo(padX, mid);
    // 上半：相邻两点中间做二次曲线，线条圆滑
    for (let i = 0; i < N - 1; i++) {
      const x0 = padX + i * step;
      g.quadraticCurveTo(x0, mid - y(i), x0 + step / 2, mid - (y(i) + y(i + 1)) / 2);
    }
    g.lineTo(padX + (N - 1) * step, mid);
    // 下半：镜像回来
    for (let i = N - 1; i > 0; i--) {
      const x0 = padX + i * step;
      g.quadraticCurveTo(x0, mid + y(i), x0 - step / 2, mid + (y(i) + y(i - 1)) / 2);
    }
    g.closePath();
  }

  /** 一圈的几何 */
  const geo = () => {
    const R = (Math.min(W, H) / 2) * 0.94;
    return { cx: W / 2, cy: H / 2, r0: R * 0.66, amp: R * 0.32 };
  };

  /** 一圈：外轮廓（往外鼓）和内轮廓（往里缩）围成一条环带；k 是振幅缩放 */
  function ringBand(g: CanvasRenderingContext2D, k: number) {
    const { cx, cy, r0, amp } = geo();
    const pt = (i: number, side: 1 | -1, dir: 1 | -1) => {
      const a = -Math.PI / 2 + side * (i / (N - 1)) * Math.PI;
      const r = r0 + dir * cur[i] * taper[i] * amp * k * (dir > 0 ? 1 : 0.55);
      return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as const;
    };
    g.beginPath();
    // 外圈：右半边从上到下，再左半边从下到上
    for (let i = 0; i < N; i++) {
      const [x, y] = pt(i, 1, 1);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    for (let i = N - 1; i >= 0; i--) {
      const [x, y] = pt(i, -1, 1);
      g.lineTo(x, y);
    }
    g.closePath();
    // 内圈：反方向走一圈，配合 evenodd 挖空中间
    for (let i = 0; i < N; i++) {
      const [x, y] = pt(i, -1, -1);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    for (let i = N - 1; i >= 0; i--) {
      const [x, y] = pt(i, 1, -1);
      g.lineTo(x, y);
    }
    g.closePath();
  }

  return {
    resize(w, h) {
      W = w;
      H = h;
      dirty = true;
    },
    setColor(c) {
      color = c;
      dirty = true;
    },
    feed(d: AudioData) {
      if (d.wave.length !== N) return;
      // 音量大小已经在 Rust 里自动增益过了；这里振幅开 0.7 次方，小声的地方也看得见起伏
      for (let i = 0; i < N; i++) target[i] = Math.pow(Math.abs(d.wave[i]) / 127, 0.7);
    },
    quiet() {
      target.fill(0);
    },
    step(dt) {
      let moving = false;
      for (let i = 0; i < N; i++) {
        const v = cur[i];
        const tv = target[i];
        cur[i] = v + (tv - v) * Math.min(1, (tv > v ? RISE : FALL) * dt);
        if (cur[i] > 0.003) moving = true;
      }
      return moving;
    },
    draw(g) {
      if (dirty) {
        dirty = false;
        if (ring) {
          // 一圈：颜色统一，不需要横向淡出
          fillStyle = rgba(color, 0.7);
          coreStyle = rgba(lighten(color, 0.55), 0.95);
          glowStyle = rgba(color, 0.26);
          lineStyle = rgba(lighten(color, 0.3), 0.45);
        } else {
          // 一排：横向渐变，两端透明，中间最亮
          const mk = (c: Rgb, a: number) => {
            const gr = g.createLinearGradient(0, 0, W, 0);
            gr.addColorStop(0, rgba(c, 0));
            gr.addColorStop(0.3, rgba(c, a * 0.7));
            gr.addColorStop(0.5, rgba(c, a));
            gr.addColorStop(0.7, rgba(c, a * 0.7));
            gr.addColorStop(1, rgba(c, 0));
            return gr;
          };
          fillStyle = mk(color, 0.75);
          coreStyle = mk(lighten(color, 0.55), 0.95);
          glowStyle = mk(color, 0.28);
          lineStyle = mk(lighten(color, 0.3), 0.6);
        }
      }
      g.lineJoin = "round";
      if (ring) {
        const { cx, cy, r0 } = geo();
        ringBand(g, 1);
        g.lineWidth = 5;
        g.strokeStyle = glowStyle;
        g.stroke();
        g.fillStyle = fillStyle;
        g.fill("evenodd");
        ringBand(g, 0.45);
        g.fillStyle = coreStyle;
        g.fill("evenodd");
        // 中线：一圈细线
        g.beginPath();
        g.arc(cx, cy, r0, 0, Math.PI * 2);
        g.lineWidth = 1;
        g.strokeStyle = lineStyle;
        g.stroke();
        return;
      }
      // 发光：轮廓外面一圈粗的半透明线
      lineOutline(g, 1);
      g.lineWidth = 6;
      g.strokeStyle = glowStyle;
      g.stroke();
      g.fillStyle = fillStyle;
      g.fill();
      // 芯：更窄、更亮
      lineOutline(g, 0.45);
      g.fillStyle = coreStyle;
      g.fill();
      // 中线
      g.fillStyle = lineStyle;
      g.fillRect(W * 0.03, H / 2 - 0.5, W * 0.94, 1);
    },
  };
}
