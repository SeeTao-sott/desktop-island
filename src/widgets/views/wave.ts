// 波形：像示波器一样画声音的实时波形，上下对称。
//   - 中间亮、往左右两端逐渐淡出：形状两头收窄，颜色也是横向渐变到透明
//   - 中间再叠一层更亮、更窄的"芯"，看起来是从中心发光
//   - 发光：沿轮廓画一圈更粗、半透明的线（不用模糊滤镜）
//   - 每个点自己平滑（涨得快、落得稍慢），不抖
import type { AudioData } from "../skins/types";
import type { Renderer, Rgb } from "./audio";

const RISE = 22;
const FALL = 9;

const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;
/** 和白色混一点，做"芯"的颜色 */
const lighten = ([r, g, b]: Rgb, k: number): Rgb => [r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k];

export function waveRenderer(): Renderer {
  let W = 0;
  let H = 0;
  const N = 128;
  const cur = new Float32Array(N);
  const target = new Float32Array(N);
  /** 两头收窄的包络 */
  const taper = new Float32Array(N);
  for (let i = 0; i < N; i++) taper[i] = Math.pow(Math.sin((Math.PI * (i + 0.5)) / N), 0.9);
  let color: Rgb = [140, 170, 255];
  let fillGrad: CanvasGradient | string = "";
  let coreGrad: CanvasGradient | string = "";
  let glowGrad: CanvasGradient | string = "";
  let lineGrad: CanvasGradient | string = "";
  let dirty = true;

  /** 沿上边走、再沿下边回来的对称轮廓；k 是振幅缩放 */
  function outline(g: CanvasRenderingContext2D, k: number) {
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
      const xm = x0 + step / 2;
      g.quadraticCurveTo(x0, mid - y(i), xm, mid - (y(i) + y(i + 1)) / 2);
    }
    g.lineTo(padX + (N - 1) * step, mid);
    // 下半：镜像回来
    for (let i = N - 1; i > 0; i--) {
      const x0 = padX + i * step;
      const xm = x0 - step / 2;
      g.quadraticCurveTo(x0, mid + y(i), xm, mid + (y(i) + y(i - 1)) / 2);
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
        // 横向渐变：两端透明，中间最亮
        const mk = (c: Rgb, a: number) => {
          const gr = g.createLinearGradient(0, 0, W, 0);
          gr.addColorStop(0, rgba(c, 0));
          gr.addColorStop(0.3, rgba(c, a * 0.7));
          gr.addColorStop(0.5, rgba(c, a));
          gr.addColorStop(0.7, rgba(c, a * 0.7));
          gr.addColorStop(1, rgba(c, 0));
          return gr;
        };
        fillGrad = mk(color, 0.75);
        coreGrad = mk(lighten(color, 0.55), 0.95);
        glowGrad = mk(color, 0.28);
        lineGrad = mk(lighten(color, 0.3), 0.6);
      }
      const mid = H / 2;
      // 发光：轮廓外面一圈粗的半透明线
      outline(g, 1);
      g.lineWidth = 6;
      g.lineJoin = "round";
      g.strokeStyle = glowGrad;
      g.stroke();
      // 主体
      g.fillStyle = fillGrad;
      g.fill();
      // 芯：更窄、更亮
      outline(g, 0.45);
      g.fillStyle = coreGrad;
      g.fill();
      // 中线
      g.fillStyle = lineGrad;
      g.fillRect(W * 0.03, mid - 0.5, W * 0.94, 1);
    },
  };
}
