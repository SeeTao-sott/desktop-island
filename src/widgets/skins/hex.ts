// 六边形主题：平顶六边形（小、大是正六边形，中是左右拉长的六边形），编辑时按蜂巢网格吸附。
//   时钟：6 个顶点 = 一小时的 6 段 10 分钟，走过的亮起来
//   番茄钟：沿六边形的边走一圈进度
//   系统状态：三层同心六边形（外 CPU、中显卡温度、内电量）
//   音乐：六边形封面，外面一圈六边形进度
import "./hex.css";
import {
  POMO_LABEL,
  STATUS_KEYS,
  attrSetter,
  coverSetter,
  dateText,
  el,
  fmtPos,
  ICON,
  mmss,
  musicButtons,
  pomoButtons,
  setter,
  statusView,
  svg,
  timeText,
  weekText,
  type Pt,
  type Skin,
} from "./types";

const SQ3 = Math.sqrt(3);

/** w×h 外框里的平顶六边形（左右两个尖角 120°；w = h·2/√3 时就是正六边形） */
export function hexPts(w: number, h: number): Pt[] {
  const k = h / (2 * SQ3);
  return [
    [k, 0],
    [w - k, 0],
    [w, h / 2],
    [w - k, h],
    [k, h],
    [0, h / 2],
  ];
}

/** 以 (cx, cy) 为中心缩放 */
function shrink(pts: Pt[], cx: number, cy: number, s: number): Pt[] {
  return pts.map(([x, y]) => [cx + (x - cx) * s, cy + (y - cy) * s]);
}
const toStr = (pts: Pt[]) => pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

/** 沿六边形走的进度条（SVG 里一个多边形，pathLength = 100） */
function hexProgress(parent: SVGElement, pts: Pt[], cls = "") {
  svg("polygon", { class: `hx-track ${cls}`, points: toStr(pts) }, parent);
  const arc = svg("polygon", { class: `hx-arc ${cls}`, points: toStr(pts), pathLength: 100, "stroke-dasharray": "100 100" }, parent);
  const at = attrSetter();
  return {
    arc,
    set: (frac: number) => at(arc, "stroke-dashoffset", (100 * (1 - Math.min(1, Math.max(0, frac)))).toFixed(2)),
  };
}

/** 正六边形区域（中尺寸时放在左边，高 = h） */
function regularBox(w: number, h: number, medium: boolean) {
  const rw = medium ? (h * 2) / SQ3 : w;
  return { w: rw, h };
}

const hex: Skin = {
  id: "hex",
  name: "六边形",
  grid: "hex",

  frame(host, _size, w, h) {
    host.classList.add("sk-hex");
    const pts = hexPts(w, h);
    const body = el("div", "hx-body", host);
    // 用百分比裁剪：尺寸动画途中形状也跟着走
    body.style.clipPath = `polygon(${pts.map(([x, y]) => `${((x / w) * 100).toFixed(2)}% ${((y / h) * 100).toFixed(2)}%`).join(",")})`;
    const content = el("div", "sk-content", body);
    const s = svg("svg", { class: "hx-lines", viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none" }, host);
    svg("polygon", { class: "hx-edge", points: toStr(shrink(pts, w / 2, h / 2, 0.985)) }, s);
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

  outline: (_size, w, h) => hexPts(w, h),

  views: {
    clock(root, ctx) {
      root.className = `hx-clock size-${ctx.size}`;
      const { w, h } = ctx;
      const s = svg("svg", { class: "hx-fill", viewBox: `0 0 ${w} ${h}` }, root);
      const inner = shrink(hexPts(w, h), w / 2, h / 2, 0.86);
      svg("polygon", { class: "hx-inner", points: toStr(inner) }, s);
      const dots = inner.map(([x, y]) => svg("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: ctx.size === "large" ? 4.5 : 3.2 }, s));
      root.insertAdjacentHTML("beforeend", `<div class="hx-center"><div class="hx-hm"></div><div class="hx-sub"></div><div class="hx-sub2"></div></div>`);
      const q = (c: string) => root.querySelector(c);
      const set = setter();
      let lit = -1;
      return {
        update(d) {
          const t = timeText(d.now, d.hour12);
          set(q(".hx-hm"), d.seconds && ctx.size !== "small" ? `${t.hm}:${t.sec}` : t.hm);
          set(q(".hx-sub"), ctx.size === "small" ? weekText(d.now) : `${dateText(d.now)}  ${weekText(d.now)}`);
          set(q(".hx-sub2"), ctx.size === "small" && d.seconds ? t.sec : t.ampm);
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
      const { w, h } = ctx;
      const s = svg("svg", { class: "hx-fill", viewBox: `0 0 ${w} ${h}` }, root);
      const prog = hexProgress(s, shrink(hexPts(w, h), w / 2, h / 2, 0.86));
      const center = el("div", "hx-center", root);
      const time = el("div", "hx-hm", center);
      const label = el("div", "hx-sub", center);
      const btns = el("div", "hx-btns", center);
      const buttons = pomoButtons(btns, ctx, "hx-btn", ctx.size === "small" ? 1 : 2);
      const set = setter();
      return {
        update(d) {
          root.dataset.phase = d.phase;
          prog.set(d.totalMs > 0 ? d.remainingMs / d.totalMs : 0);
          set(time, d.phase === "done" ? "完成" : mmss(d.remainingMs));
          set(label, POMO_LABEL[d.phase]);
          buttons(d.phase);
        },
        destroy: () => root.replaceChildren(),
      };
    },

    music(root, ctx) {
      root.className = `hx-music size-${ctx.size}`;
      const medium = ctx.size === "medium";
      // 封面区域：小 = 整个六边形；中 = 左边一个正六边形；大 = 上半部分一个正六边形
      const area = el("div", "hx-art", root);
      const box = medium ? regularBox(ctx.w, ctx.h, true) : ctx.size === "large" ? { w: ctx.w * 0.56, h: ctx.w * 0.56 * (SQ3 / 2) } : { w: ctx.w, h: ctx.h };
      area.style.width = `${box.w}px`;
      area.style.height = `${box.h}px`;
      const disc = el("div", "hx-disc", area);
      const pts = hexPts(box.w, box.h);
      const innerPts = shrink(pts, box.w / 2, box.h / 2, ctx.size === "small" ? 0.78 : 0.8);
      disc.style.clipPath = `polygon(${innerPts.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(",")})`;
      const img = el("img", "", disc);
      img.alt = "";
      el("span", "hx-ph", disc).innerHTML = ICON.note;
      const cover = coverSetter(img);
      const s = svg("svg", { class: "hx-fill", viewBox: `0 0 ${box.w} ${box.h}` }, area);
      const prog = hexProgress(s, shrink(pts, box.w / 2, box.h / 2, 0.9));
      const info = el("div", "hx-info", root);
      const title = el("div", "hx-title", info);
      const artist = el("div", "hx-artist", info);
      const pos = el("div", "hx-pos", info);
      const ctrl = el("div", "hx-ctrl", ctx.size === "small" ? area : info);
      const buttons = musicButtons(ctrl, ctx, "hx-mbtn", ctx.size === "small" ? ["toggle"] : ["prev", "toggle", "next"]);
      const idle = el("div", "hx-idle", info);
      idle.textContent = "没有在播放";
      const set = setter();
      return {
        update(d) {
          root.classList.toggle("active", d.active);
          cover(d.cover);
          prog.set(d.active && d.durationMs > 0 ? d.positionMs / d.durationMs : 0);
          if (!d.active) return;
          set(title, d.title);
          set(artist, d.artist);
          set(pos, d.durationMs > 0 ? `${fmtPos(d.positionMs)} / ${fmtPos(d.durationMs)}` : "");
          buttons(d);
        },
        destroy: () => root.replaceChildren(),
      };
    },

    status(root, ctx) {
      root.className = `hx-status size-${ctx.size}`;
      const medium = ctx.size === "medium";
      const box = medium ? regularBox(ctx.w, ctx.h, true) : { w: ctx.w, h: ctx.h };
      const area = el("div", "hx-art", root);
      area.style.width = `${box.w}px`;
      area.style.height = `${box.h}px`;
      const s = svg("svg", { class: "hx-fill", viewBox: `0 0 ${box.w} ${box.h}` }, area);
      const base = hexPts(box.w, box.h);
      const scale = { cpu: 0.88, gpu: 0.72, bat: 0.56 };
      const progs = STATUS_KEYS.map((k) => ({ k, p: hexProgress(s, shrink(base, box.w / 2, box.h / 2, scale[k]), `st ${k}`) }));
      const center = el("div", "hx-center", area);
      const big = el("div", "hx-hm", center);
      const bigLabel = el("div", "hx-sub", center);
      const legend = el("div", ctx.size === "large" ? "hx-legend in" : "hx-legend", ctx.size === "large" ? center : root);
      const rows = STATUS_KEYS.map((k) => {
        const row = el("div", `hx-lrow ${k}`, legend);
        el("i", "", row);
        const name = el("span", "hx-lname", row);
        const val = el("span", "hx-lval", row);
        return { k, row, name, val };
      });
      const set = setter();
      return {
        update(d) {
          const v = statusView(d);
          for (const { k, p } of progs) {
            p.set(v[k].frac);
            p.arc.classList.toggle("warn", v[k].warn);
          }
          for (const r of rows) {
            set(r.name, r.k === "bat" && v.bat.note ? `${v.bat.label} · ${v.bat.note}` : v[r.k].label);
            set(r.val, v[r.k].text);
            r.row.classList.toggle("warn", v[r.k].warn);
          }
          set(big, ctx.size === "large" ? "" : v.cpu.text);
          set(bigLabel, ctx.size === "large" ? "" : "CPU");
        },
        destroy: () => root.replaceChildren(),
      };
    },
  },
};

export default hex;
