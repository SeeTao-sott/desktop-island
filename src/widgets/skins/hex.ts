// 六边形主题：平顶六边形（小、大是正六边形，中是左右拉长的六边形），方便以后拼成蜂巢。
// 番茄钟沿着六边形的边走一圈进度；时钟的 6 个顶点是 6 段 10 分钟，走过的亮起来。
import "./hex.css";
import { SIZES, spanPx, type SizeKey } from "../types";
import { mmss, pomoButtons, POMO_LABEL, setter, timeText, dateText, weekText, el, svg, type Skin } from "./types";

/** 在 w×h 的格子里放一个平顶六边形，返回 6 个顶点（左上角起顺时针） */
export function hexPoints(size: SizeKey): { w: number; h: number; pts: [number, number][] } {
  const w = spanPx(SIZES[size].cols);
  const box = spanPx(SIZES[size].rows);
  if (size === "medium") {
    // 拉长的六边形：左右两个尖角保持 120°
    const h = box;
    const k = (h / 2) * Math.tan(Math.PI / 6);
    return { w, h: box, pts: [[k, 0], [w - k, 0], [w, h / 2], [w - k, h], [k, h], [0, h / 2]] };
  }
  // 正六边形：宽 = 格子宽，高 = 宽 × √3/2，上下居中
  const h = (w * Math.sqrt(3)) / 2;
  const y0 = (box - h) / 2;
  return {
    w,
    h: box,
    pts: [
      [w / 4, y0],
      [(w * 3) / 4, y0],
      [w, box / 2],
      [(w * 3) / 4, y0 + h],
      [w / 4, y0 + h],
      [0, box / 2],
    ],
  };
}

const toStr = (pts: [number, number][]) => pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

/** 以中心缩放一组顶点 */
function shrink(pts: [number, number][], w: number, h: number, k: number): [number, number][] {
  return pts.map(([x, y]) => [w / 2 + (x - w / 2) * k, h / 2 + (y - h / 2) * k]);
}

const hex: Skin = {
  id: "hex",
  name: "六边形",

  frame(host, size) {
    host.classList.add("sk-hex", `hx-${size}`);
    const { w, h, pts } = hexPoints(size);
    const body = el("div", "hx-body", host);
    body.style.clipPath = `polygon(${pts.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(",")})`;
    const content = el("div", "sk-content", body);
    const s = svg("svg", { class: "hx-lines", viewBox: `0 0 ${w} ${h}`, width: w, height: h }, host);
    svg("polygon", { class: "hx-edge", points: toStr(shrink(pts, w, h, 0.985)) }, s);
    svg("polygon", { class: "hx-inner", points: toStr(shrink(pts, w, h, 0.86)) }, s);
    return {
      content,
      frame: {
        setPaused() {},
        destroy() {
          body.remove();
          s.remove();
        },
      },
    };
  },

  views: {
    clock(root, ctx) {
      root.className = `hx-clock size-${ctx.size}`;
      const { w, h, pts } = hexPoints(ctx.size);
      const s = svg("svg", { class: "hx-dots", viewBox: `0 0 ${w} ${h}` }, root);
      const dots = shrink(pts, w, h, 0.86).map(([x, y]) => svg("circle", { cx: x, cy: y, r: 3.2 }, s));
      root.insertAdjacentHTML(
        "beforeend",
        `<div class="hx-center"><div class="hx-hm"></div><div class="hx-sub"></div></div>`,
      );
      const set = setter();
      const q = (c: string) => root.querySelector(c);
      let lit = -1;
      return {
        update(d) {
          const t = timeText(d.now, d.hour12);
          // 小六边形放不下秒数
          set(q(".hx-hm"), d.seconds && ctx.size !== "small" ? `${t.hm}:${t.sec}` : t.hm);
          set(q(".hx-sub"), ctx.size === "small" ? weekText(d.now) : `${dateText(d.now)}  ${weekText(d.now)}`);
          // 6 个顶点 = 一小时的 6 段 10 分钟
          const n = Math.floor(d.now.getMinutes() / 10) + 1;
          if (n !== lit) {
            lit = n;
            dots.forEach((c, i) => c.classList.toggle("on", i < n));
          }
        },
        destroy: () => root.replaceChildren(),
      };
    },

    pomodoro(root, ctx) {
      root.className = `hx-pomo size-${ctx.size}`;
      const { w, h, pts } = hexPoints(ctx.size);
      const s = svg("svg", { class: "hx-prog", viewBox: `0 0 ${w} ${h}` }, root);
      const inner = toStr(shrink(pts, w, h, 0.86));
      svg("polygon", { class: "hx-track", points: inner }, s);
      const prog = svg("polygon", { class: "hx-arc", points: inner, pathLength: 100, "stroke-dasharray": "100 100" }, s);
      const center = el("div", "hx-center", root);
      const time = el("div", "hx-hm", center);
      const label = el("div", "hx-sub", center);
      const btns = el("div", "hx-btns", center);
      const buttons = pomoButtons(btns, ctx, "hx-btn", ctx.size === "small" ? 1 : 2);
      const set = setter();
      return {
        update(d) {
          root.dataset.phase = d.phase;
          prog.setAttribute("stroke-dashoffset", String(100 * (1 - d.remainingMs / d.totalMs)));
          set(time, d.phase === "done" ? "完成" : mmss(d.remainingMs));
          set(label, POMO_LABEL[d.phase]);
          buttons(d.phase);
        },
        destroy: () => root.replaceChildren(),
      };
    },
  },
};

export default hex;
