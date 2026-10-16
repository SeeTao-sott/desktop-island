// 音频可视化（频谱柱）的驱动部分：一个 canvas + 频谱柱的画法。
//   - 每收到一帧数据画一次（最多 60 / 30 帧，不跟着 144Hz 屏幕空转）
//   - 没声音后只把画面落完、淡出完，然后完全停下，不再重绘
//   - 主题颜色缓存起来，每隔一阵才检查一次有没有变
import type { AudioData, View, ViewCtx } from "../skins/types";
import { barsRenderer } from "./bars";

export type Rgb = [number, number, number];

/** 画法：自己管状态和颜色，驱动部分负责什么时候画 */
export interface Renderer {
  resize(w: number, h: number): void;
  setColor(c: Rgb): void;
  /** 新数据 */
  feed(d: AudioData): void;
  /** 没声音了：目标归零 */
  quiet(): void;
  /** 往前走 dt 秒；还在动就返回 true */
  step(dt: number): boolean;
  draw(g: CanvasRenderingContext2D, fade: number): void;
}

/** 淡入淡出速度（每秒） */
const FADE_IN = 4;
const FADE_OUT = 1.2;
/** 超过这么久没收到新帧，当作没声音 */
const STALE_MS = 400;

function parseRgb(s: string): Rgb | null {
  const m = s.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}

/** 排布：一排横着（方形、HUD、六边形主题）或者绕成一圈（圆环主题） */
export type Layout = "line" | "ring";

export function audioView(root: HTMLElement, ctx: ViewCtx, layout: Layout = "line"): View<AudioData> {
  root.className = `viz viz-${layout} size-${ctx.size}`;
  const canvas = document.createElement("canvas");
  root.appendChild(canvas);
  const g = canvas.getContext("2d")!;

  const r = barsRenderer(layout);
  let data: AudioData | null = null;
  let fade = 0;
  let lastT = 0;
  let rafPending = false;
  let idleTimer = 0;
  let W = 0;
  let H = 0;
  let dpr = 1;
  let colorKey = "";
  let colorAge = 99;

  /** 指定了颜色（封面 / 手动）就用它；没指定才看壁纸的强调色 */
  let explicit: Rgb | null = null;
  let explicitKey = "";
  function refreshColor(force = false) {
    if (explicit) {
      const k = explicit.join(",");
      if (k !== explicitKey || force) {
        explicitKey = k;
        r.setColor(explicit);
      }
      return;
    }
    if (!force && ++colorAge < 30) return;
    colorAge = 0;
    const a = getComputedStyle(root).getPropertyValue("--w-accent").trim();
    if (a === colorKey && !force) return;
    colorKey = a;
    const c = parseRgb(a);
    if (c) r.setColor(c);
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = root.clientWidth;
    H = root.clientHeight;
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    r.resize(W, H);
    refreshColor(true);
    draw();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(root);

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
    if (stale) r.quiet();
    fade = stale ? Math.max(0, fade - FADE_OUT * dt) : Math.min(1, fade + FADE_IN * dt);
    const moving = r.step(dt);
    draw();
    if (!stale) return; // 有声音：等下一批数据来了再画
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
    if (fade <= 0) return;
    refreshColor();
    g.globalAlpha = fade;
    r.draw(g, fade);
    g.globalAlpha = 1;
  }

  resize();

  return {
    update(d) {
      // 颜色来源变了（壁纸 ↔ 封面 / 手动）：马上换色
      const was = explicit;
      explicit = d.color;
      if (!!was !== !!explicit || (explicit && explicit.join() !== explicitKey)) {
        explicitKey = "";
        refreshColor(true);
        if (!explicit) colorKey = "";
      }
      data = d;
      if (!d.silent) r.feed(d);
      kick();
    },
    destroy() {
      window.clearTimeout(idleTimer);
      ro.disconnect();
      root.replaceChildren();
    },
  };
}
