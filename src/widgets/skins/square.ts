// 方形主题：圆角半透明玻璃卡片（原来的样子）
import "./square.css";
import "./square-clock.css";
import "./square-music.css";
import "./square-pomodoro.css";
import "./square-status.css";
import {
  ICON,
  POMO_LABEL,
  STATUS_KEYS,
  WEEK,
  attrSetter,
  coverSetter,
  dateText,
  el,
  fmtPos,
  mmss,
  musicButtons,
  pomoButtons,
  roundRectOutline,
  setter,
  statusView,
  svg,
  timeText,
  weekText,
  type Skin,
} from "./types";

const RADIUS = 22;

/** 大尺寸时钟下面的月历 */
function calendar(d: Date) {
  const box = el("div", "cal");
  for (const w of WEEK) el("span", "cal-head", box).textContent = w;
  const first = new Date(d.getFullYear(), d.getMonth(), 1).getDay();
  const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  for (let i = 0; i < first; i++) el("span", "", box);
  for (let n = 1; n <= days; n++) el("span", "cal-day" + (n === d.getDate() ? " today" : ""), box).textContent = String(n);
  return box;
}

const ICON_STAT = {
  cpu: '<svg viewBox="0 0 24 24"><path d="M9 3v2H7a2 2 0 0 0-2 2v2H3v2h2v2H3v2h2v2a2 2 0 0 0 2 2h2v2h2v-2h2v2h2v-2h2a2 2 0 0 0 2-2v-2h2v-2h-2v-2h2V9h-2V7a2 2 0 0 0-2-2h-2V3h-2v2h-2V3H9zm-2 4h10v10H7V7zm3 3v4h4v-4h-4z"/></svg>',
  gpu: '<svg viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 0-3 3v8.3a5 5 0 1 0 6 0V5a3 3 0 0 0-3-3zm0 2a1 1 0 0 1 1 1v9.3l.4.3a3 3 0 1 1-2.8 0l.4-.3V5a1 1 0 0 1 1-1zm-1 6v5.2a2 2 0 1 0 2 0V10h-2z"/></svg>',
  bat: '<svg viewBox="0 0 24 24"><path d="M9 2h6v2h2a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2V2zM8 6v14h8V6H8z"/></svg>',
};

const square: Skin = {
  id: "square",
  name: "方形",
  grid: "rect",

  frame(host) {
    host.classList.add("sk-square");
    const body = el("div", "sq-body", host);
    const content = el("div", "sk-content", body);
    return { content, frame: { setPaused() {}, destroy: () => body.remove() } };
  },

  outline: (_size, w, h) => roundRectOutline(w, h, RADIUS),

  views: {
    clock(root, ctx) {
      root.className = `w-clock size-${ctx.size}`;
      root.innerHTML = `
        <div class="clk-time"><span class="clk-ampm"></span><span class="clk-hm"></span><span class="clk-sec"></span></div>
        <div class="clk-date"><span class="clk-day"></span><span class="clk-week"></span></div>
        ${ctx.size === "large" ? '<div class="clk-cal"></div>' : ""}`;
      const q = (c: string) => root.querySelector(c);
      const set = setter();
      let calDay = "";
      return {
        update(d) {
          const t = timeText(d.now, d.hour12);
          set(q(".clk-ampm"), t.ampm);
          set(q(".clk-hm"), t.hm);
          set(q(".clk-sec"), d.seconds ? t.sec : "");
          set(q(".clk-day"), dateText(d.now));
          set(q(".clk-week"), weekText(d.now));
          const cal = q(".clk-cal");
          const key = d.now.toDateString();
          if (cal && key !== calDay) {
            calDay = key;
            cal.replaceChildren(calendar(d.now));
          }
        },
        destroy: () => root.replaceChildren(),
      };
    },

    pomodoro(root, ctx) {
      root.className = `w-pomo size-${ctx.size}`;
      const R = 44;
      const C = 2 * Math.PI * R;
      const ring = el("div", "po-ring", root);
      const s = svg("svg", { viewBox: "0 0 100 100" }, ring);
      svg("circle", { class: "po-track", cx: 50, cy: 50, r: R }, s);
      const arc = svg("circle", { class: "po-arc", cx: 50, cy: 50, r: R, "stroke-dasharray": C }, s);
      const center = el("div", "po-center", ring);
      const time = el("div", "po-time", center);
      const label = el("div", "po-label", center);
      const side = el("div", "po-side", root);
      const state = el("div", "po-state", side);
      const btns = el("div", "po-btns", side);
      const buttons = pomoButtons(btns, ctx, "po-btn", ctx.size === "small" ? 1 : 2);
      const set = setter();
      const at = attrSetter();
      return {
        update(d) {
          root.dataset.phase = d.phase;
          set(time, d.phase === "done" ? "完成" : mmss(d.remainingMs));
          const mins = Math.round(d.totalMs / 60_000);
          set(label, d.phase === "idle" ? `${mins} 分钟` : POMO_LABEL[d.phase]);
          set(state, d.phase === "idle" ? `专注 ${mins} 分钟` : POMO_LABEL[d.phase]);
          at(arc, "stroke-dashoffset", (C * (1 - d.remainingMs / d.totalMs)).toFixed(2));
          buttons(d.phase);
        },
        destroy: () => root.replaceChildren(),
      };
    },

    music(root, ctx) {
      root.className = `w-music size-${ctx.size}`;
      root.innerHTML = `
        <div class="mu-cover"><img alt="" hidden /><span class="mu-ph">${ICON.note}</span></div>
        <div class="mu-meta"><div class="mu-title"></div><div class="mu-artist"></div></div>
        <div class="mu-progress"><div class="mu-bar"><i></i></div><span class="mu-el"></span><span class="mu-tot"></span></div>
        <div class="mu-ctrl"></div>
        <div class="mu-idle">没有在播放</div>`;
      const q = <T extends Element>(c: string) => root.querySelector<T>(c)!;
      const buttons = musicButtons(q(".mu-ctrl"), ctx, "mu-btn");
      const cover = coverSetter(q<HTMLImageElement>("img"));
      const set = setter();
      const at = attrSetter();
      return {
        update(d) {
          root.classList.toggle("active", d.active);
          cover(d.cover);
          if (!d.active) return;
          set(q(".mu-title"), d.title);
          set(q(".mu-artist"), d.artist);
          buttons(d);
          const has = d.durationMs > 0;
          at(q(".mu-progress"), "--vis", has ? "visible" : "hidden");
          if (has) {
            at(q(".mu-bar i"), "transform", `scaleX(${(d.positionMs / d.durationMs).toFixed(4)})`);
            set(q(".mu-el"), fmtPos(d.positionMs));
            set(q(".mu-tot"), fmtPos(d.durationMs));
          }
        },
        destroy: () => root.replaceChildren(),
      };
    },

    status(root, ctx) {
      root.className = `w-status size-${ctx.size}`;
      const R = 40;
      const C = 2 * Math.PI * R;
      const ring = ctx.size !== "small";
      const grid = el("div", "st-grid", root);
      const cells = STATUS_KEYS.map((k) => {
        const box = el("div", "st-cell", grid);
        let arc: SVGCircleElement | null = null;
        let val: HTMLElement;
        if (ring) {
          const r = el("div", "st-ring", box);
          const s = svg("svg", { viewBox: "0 0 100 100" }, r);
          svg("circle", { class: "st-track", cx: 50, cy: 50, r: R }, s);
          arc = svg("circle", { class: "st-arc", cx: 50, cy: 50, r: R, "stroke-dasharray": C, "stroke-dashoffset": C }, s);
          val = el("div", "st-val", r);
        } else {
          el("span", "st-ic", box).innerHTML = ICON_STAT[k];
          val = el("span", "st-val", box);
        }
        const label = el("div", "st-label", box);
        return { k, box, arc, val, label };
      });
      let line: SVGPolylineElement | null = null;
      if (ctx.size === "large") {
        const chart = el("div", "st-chart", root);
        el("div", "st-chart-title", chart).textContent = "CPU · 最近 60 次";
        const s = svg("svg", { viewBox: "0 0 59 100", preserveAspectRatio: "none" }, chart);
        line = svg("polyline", {}, s);
      }
      const set = setter();
      const at = attrSetter();
      return {
        update(d) {
          const v = statusView(d);
          for (const c of cells) {
            const x = v[c.k];
            set(c.val, x.text);
            set(c.label, x.note && ctx.size !== "small" ? `${x.label} · ${x.note}` : x.label);
            c.box.classList.toggle("warn", x.warn);
            if (c.arc) at(c.arc, "stroke-dashoffset", (C * (1 - x.frac)).toFixed(2));
          }
          if (line) at(line, "points", d.history.map((p, i) => `${i + (60 - d.history.length)},${(100 - p).toFixed(1)}`).join(" "));
        },
        destroy: () => root.replaceChildren(),
      };
    },
  },
};

export default square;
