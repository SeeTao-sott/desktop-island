// 频谱柱：从低音到高音一排竖柱。
//   - 升起快（约 40 毫秒追上）、落下慢（从满到底约 0.9 秒），看起来顺滑不抖
//   - 柔和发光：柱子后面先画一层更宽、半透明的同色柱（不用 shadowBlur，便宜得多）
//   - 倒影：基线下方镜像一份（柱高的一半），往下渐渐淡掉
import type { AudioData } from "../skins/types";
import type { Renderer, Rgb } from "./audio";

const RISE = 28;
const FALL = 1.1;

const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;

export function barsRenderer(): Renderer {
  let W = 0;
  let H = 0;
  let n = 0;
  let cur = new Float32Array(0);
  let target = new Float32Array(0);
  let color: Rgb = [140, 170, 255];
  let body: CanvasGradient | string = "";
  let refl: CanvasGradient | string = "";
  let glow = "";
  let dirty = true;

  return {
    resize(w, h) {
      W = w;
      H = h;
      // 柱子数量：按宽度来，每根约 7 像素
      const k = Math.max(12, Math.min(64, Math.floor(w / 7)));
      if (k !== n) {
        n = k;
        cur = new Float32Array(n);
        target = new Float32Array(n);
      }
      dirty = true;
    },
    setColor(c) {
      color = c;
      dirty = true;
    },
    feed(d: AudioData) {
      // 64 个频段合成 n 根柱子（每根取段内最大值）
      const m = d.bands.length;
      if (!m) return;
      for (let i = 0; i < n; i++) {
        const a = Math.floor((i * m) / n);
        const z = Math.max(a + 1, Math.floor(((i + 1) * m) / n));
        let v = 0;
        for (let k = a; k < z; k++) v = Math.max(v, d.bands[k]);
        target[i] = v / 255;
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
        cur[i] = tv > v ? v + (tv - v) * Math.min(1, RISE * dt) : Math.max(tv, v - FALL * dt);
        if (cur[i] > 0.002) moving = true;
      }
      return moving;
    },
    draw(g) {
      const base = H * 0.7; // 基线：上面是柱子，下面是倒影
      if (dirty) {
        dirty = false;
        const b = g.createLinearGradient(0, H * 0.1, 0, base);
        b.addColorStop(0, rgba(color, 1));
        b.addColorStop(1, rgba(color, 0.55));
        body = b;
        const r = g.createLinearGradient(0, base, 0, H);
        r.addColorStop(0, rgba(color, 0.32));
        r.addColorStop(1, rgba(color, 0));
        refl = r;
        glow = rgba(color, 0.22);
      }
      const padX = Math.max(10, W * 0.05);
      const maxH = base - H * 0.1;
      const slot = (W - padX * 2) / n;
      const bw = Math.max(2, slot * 0.62);
      const rad = Math.min(2, bw / 2);
      // 三层各自一次画完，减少换颜色的次数
      g.fillStyle = glow;
      for (let i = 0; i < n; i++) {
        const h = Math.max(1.5, cur[i] * maxH);
        g.fillRect(padX + i * slot + (slot - bw) / 2 - 2, base - h - 2, bw + 4, h + 2);
      }
      g.fillStyle = body;
      g.beginPath();
      for (let i = 0; i < n; i++) {
        const h = Math.max(1.5, cur[i] * maxH);
        g.roundRect(padX + i * slot + (slot - bw) / 2, base - h, bw, h, [rad, rad, 0, 0]);
      }
      g.fill();
      g.fillStyle = refl;
      for (let i = 0; i < n; i++) {
        const h = Math.max(1.5, cur[i] * maxH);
        g.fillRect(padX + i * slot + (slot - bw) / 2, base + 2, bw, h * 0.5);
      }
    },
  };
}
