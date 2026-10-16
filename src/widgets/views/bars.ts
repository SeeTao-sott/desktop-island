// 频谱柱：从低音到高音一排竖柱；圆环主题下绕成一圈（左右对称，低音在上，高音在下）。
//   - 升起快（约 40 毫秒追上）、落下慢（从满到底约 0.9 秒），看起来顺滑不抖
//   - 柔和发光：柱子后面先画一层更宽、半透明的同色柱（不用 shadowBlur，便宜得多）
//   - 倒影：一排时在基线下方；一圈时朝圆心方向，渐渐淡掉
import type { AudioData } from "../skins/types";
import type { Layout, Renderer, Rgb } from "./audio";

const RISE = 28;
const FALL = 1.1;
/** 一圈时每边的柱子数（两边对称，共 64 根） */
const RING_HALF = 32;

const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;

export function barsRenderer(layout: Layout): Renderer {
  const ring = layout === "ring";
  let W = 0;
  let H = 0;
  let n = 0;
  let cur = new Float32Array(0);
  let target = new Float32Array(0);
  let color: Rgb = [140, 170, 255];
  let body: CanvasGradient | string = "";
  let refl: CanvasGradient | string = "";
  let glow = "";
  let faint = "";
  let dirty = true;

  /** 一圈时的几何：圆心、内圈半径、柱子最长 */
  const geo = () => {
    const R = (Math.min(W, H) / 2) * 0.94;
    return { cx: W / 2, cy: H / 2, r0: R * 0.5, len: R * 0.48 };
  };

  return {
    resize(w, h) {
      W = w;
      H = h;
      // 柱子数量：一排时按宽度，每根约 7 像素；一圈时固定每边 32 根
      const k = ring ? RING_HALF : Math.max(12, Math.min(64, Math.floor(w / 7)));
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
      if (ring) drawRing(g);
      else drawLine(g);
    },
  };

  function drawLine(g: CanvasRenderingContext2D) {
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
  }

  function drawRing(g: CanvasRenderingContext2D) {
    const { cx, cy, r0, len } = geo();
    if (dirty) {
      dirty = false;
      const b = g.createRadialGradient(cx, cy, r0, cx, cy, r0 + len);
      b.addColorStop(0, rgba(color, 0.6));
      b.addColorStop(1, rgba(color, 1));
      body = b;
      const r = g.createRadialGradient(cx, cy, r0 - len * 0.4, cx, cy, r0);
      r.addColorStop(0, rgba(color, 0));
      r.addColorStop(1, rgba(color, 0.3));
      refl = r;
      glow = rgba(color, 0.2);
      faint = rgba(color, 0.18);
    }
    // 每根柱子的方向：右半边从正上方顺时针到正下方，左半边镜像
    const bw = Math.max(2, ((Math.PI * 2 * r0) / (n * 2)) * 0.62);
    const ray = (k: number, side: 1 | -1) => {
      const a = -Math.PI / 2 + side * ((k + 0.5) / n) * Math.PI;
      return [Math.cos(a), Math.sin(a)] as const;
    };
    const path = (from: (k: number) => number, to: (k: number) => number) => {
      g.beginPath();
      for (let k = 0; k < n; k++) {
        for (const side of [1, -1] as const) {
          const [dx, dy] = ray(k, side);
          g.moveTo(cx + dx * from(k), cy + dy * from(k));
          g.lineTo(cx + dx * to(k), cy + dy * to(k));
        }
      }
    };
    const out = (k: number) => r0 + Math.max(1.5, cur[k] * len);
    // 内圈一道淡线
    g.beginPath();
    g.arc(cx, cy, r0 - 1, 0, Math.PI * 2);
    g.strokeStyle = faint;
    g.lineWidth = 1;
    g.stroke();
    // 发光层 → 柱身 → 朝圆心的倒影
    g.lineCap = "round";
    path(() => r0, out);
    g.strokeStyle = glow;
    g.lineWidth = bw + 4;
    g.stroke();
    g.strokeStyle = body;
    g.lineWidth = bw;
    g.stroke();
    g.lineCap = "butt";
    path(
      () => r0 - 2,
      (k) => r0 - 2 - Math.max(0, cur[k] * len * 0.35),
    );
    g.strokeStyle = refl;
    g.stroke();
  }
}
