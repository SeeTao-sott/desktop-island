// 圆环主题：组件是圆形（中尺寸是胶囊形：左边圆、右边信息）。
//   时钟：外圈 60 格发光刻度，走过的分钟（开了秒就是秒）亮起来
//   番茄钟：像游戏技能冷却，圆盘上一块暗色扇形随时间顺时针退去，边上一根亮线
//   系统状态：三圈同心圆环（外 CPU、中显卡温度、内电量）
//   音乐：圆形封面，外圈是播放进度
import "./ring.css";
import { audioView } from "../views/audio";
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
  roundOutline,
  setter,
  statusView,
  svg,
  timeText,
  weekText,
  type Skin,
} from "./types";

/** 外圈细进度环（SVG 100×100，从 12 点钟方向顺时针） */
function progressRing(parent: Element, r: number, cls = "") {
  const C = 2 * Math.PI * r;
  const s = svg("svg", { viewBox: "0 0 100 100", class: `rg-outer ${cls}` }, parent);
  svg("circle", { class: "rg-track", cx: 50, cy: 50, r }, s);
  // 发光：下面垫一条更粗、半透明的同样进度（不用模糊滤镜，每秒更新也几乎不费显卡）
  const glow = svg("circle", { class: "rg-glowline", cx: 50, cy: 50, r, "stroke-dasharray": C.toFixed(2) }, s);
  const arc = svg("circle", { class: "rg-arc", cx: 50, cy: 50, r, "stroke-dasharray": C.toFixed(2) }, s);
  const at = attrSetter();
  return (frac: number) => {
    const off = (C * (1 - Math.min(1, Math.max(0, frac)))).toFixed(2);
    at(glow, "stroke-dashoffset", off);
    at(arc, "stroke-dashoffset", off);
  };
}

const ring: Skin = {
  id: "ring",
  name: "圆环",
  grid: "rect",

  frame(host, size) {
    host.classList.add("sk-ring", `rg-${size}`);
    const body = el("div", "rg-body", host);
    const content = el("div", "sk-content", body);
    return { content, frame: { setPaused() {}, destroy: () => body.remove() } };
  },

  outline: (_size, w, h) => roundOutline(w, h),

  views: {
    // 音频可视化：频谱柱绕成一圈；通栏太扁画不了圆，用横排
    audio: (root, ctx) => audioView(root, ctx, ctx.size === "full" ? "line" : "ring"),

    clock(root, ctx) {
      root.className = `rg-clock size-${ctx.size}`;
      const dial = el("div", "rg-dial", root);
      const s = svg("svg", { viewBox: "0 0 100 100" }, dial);
      const dim = svg("g", { class: "rg-ticks" }, s);
      const lit = svg("g", { class: "rg-ticks lit" }, s);
      const ticks: SVGLineElement[] = [];
      for (let i = 0; i < 60; i++) {
        const major = i % 5 === 0;
        const a = (i / 60) * Math.PI * 2;
        const [r1, r2] = major ? [39, 47] : [43, 47];
        ticks.push(
          svg(
            "line",
            {
              x1: (50 + Math.sin(a) * r1).toFixed(2),
              y1: (50 - Math.cos(a) * r1).toFixed(2),
              x2: (50 + Math.sin(a) * r2).toFixed(2),
              y2: (50 - Math.cos(a) * r2).toFixed(2),
              class: major ? "major" : "",
            },
            dim,
          ),
        );
      }
      const center = el("div", "rg-center", dial);
      const hm = el("div", "rg-hm", center);
      const small = el("div", "rg-small", center);
      const small2 = el("div", "rg-small2", center);
      const side = el("div", "rg-side", root);
      const day = el("div", "rg-day", side);
      const week = el("div", "rg-week", side);
      const set = setter();
      let litCount = -1;
      return {
        update(d) {
          const t = timeText(d.now, d.hour12);
          set(hm, t.hm);
          set(small, d.seconds ? t.sec : ctx.size === "medium" ? t.ampm : dateText(d.now));
          set(small2, ctx.size === "large" ? weekText(d.now) : "");
          set(day, dateText(d.now));
          set(week, weekText(d.now));
          // 亮起来的刻度：只在数量变了时搬动（每分钟一次，开了秒就每秒一次）
          const n = (d.seconds ? d.now.getSeconds() : d.now.getMinutes()) + 1;
          if (n !== litCount) {
            litCount = n;
            ticks.forEach((t, i) => {
              const target = i < n ? lit : dim;
              if (t.parentNode !== target) target.appendChild(t);
            });
          }
        },
        destroy: () => root.replaceChildren(),
      };
    },

    pomodoro(root, ctx) {
      root.className = `rg-pomo size-${ctx.size}`;
      const dial = el("div", "rg-dial", root);
      const prog = progressRing(dial, 47);
      // 冷却圆盘：暗色扇形 = 还剩的部分；亮线 = 扇形的边
      const cd = el("div", "rg-cd", dial);
      const hand = el("div", "rg-hand", cd);
      const center = el("div", "rg-center", dial);
      const time = el("div", "rg-hm", center);
      const label = el("div", "rg-small", center);
      const side = el("div", "rg-side", root);
      const state = el("div", "rg-state", side);
      const btns = el("div", "rg-btns", ctx.size === "medium" ? side : center);
      const buttons = pomoButtons(btns, ctx, "rg-btn", ctx.size === "small" ? 1 : 2);
      const set = setter();
      const at = attrSetter();
      return {
        update(d) {
          root.dataset.phase = d.phase;
          const left = d.totalMs > 0 ? d.remainingMs / d.totalMs : 0;
          const passed = ((1 - left) * 360).toFixed(1);
          at(cd, "--passed", `${passed}deg`);
          at(hand, "transform", `rotate(${passed}deg)`);
          hand.hidden = d.phase === "idle" || d.phase === "done";
          prog(left);
          set(time, d.phase === "done" ? "就绪" : mmss(d.remainingMs));
          set(label, POMO_LABEL[d.phase]);
          set(state, POMO_LABEL[d.phase]);
          buttons(d.phase);
        },
        destroy: () => root.replaceChildren(),
      };
    },

    music(root, ctx) {
      root.className = `rg-music size-${ctx.size}`;
      const dial = el("div", "rg-dial", root);
      const prog = progressRing(dial, 47);
      const disc = el("div", "rg-disc", dial);
      const img = el("img", "", disc);
      img.alt = "";
      el("span", "rg-ph", disc).innerHTML = ICON.note;
      const cover = coverSetter(img);
      const side = el("div", "rg-side", root);
      const title = el("div", "rg-title", side);
      const artist = el("div", "rg-artist", side);
      const pos = el("div", "rg-pos", side);
      const ctrl = el("div", "rg-ctrl", ctx.size === "small" ? dial : side);
      const buttons = musicButtons(ctrl, ctx, "rg-mbtn", ctx.size === "small" ? ["toggle"] : ["prev", "toggle", "next"]);
      const idle = el("div", "rg-idle", side);
      idle.textContent = "没有在播放";
      const set = setter();
      return {
        update(d) {
          root.classList.toggle("active", d.active);
          root.classList.toggle("playing", d.playing);
          cover(d.cover);
          prog(d.active && d.durationMs > 0 ? d.positionMs / d.durationMs : 0);
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
      root.className = `rg-status size-${ctx.size}`;
      const dial = el("div", "rg-dial", root);
      const s = svg("svg", { viewBox: "0 0 100 100", class: "rg-outer" }, dial);
      const radii = { cpu: 45, gpu: 36, bat: 27 };
      const arcs = STATUS_KEYS.map((k) => {
        const r = radii[k];
        const C = 2 * Math.PI * r;
        svg("circle", { class: "rg-track st", cx: 50, cy: 50, r }, s);
        const arc = svg("circle", { class: `rg-arc st ${k}`, cx: 50, cy: 50, r, "stroke-dasharray": C.toFixed(2), "stroke-dashoffset": C.toFixed(2) }, s);
        return { k, arc, C };
      });
      const center = el("div", "rg-center", dial);
      const big = el("div", "rg-hm", center);
      const bigLabel = el("div", "rg-small", center);
      const list = el("div", ctx.size === "large" ? "rg-legend in" : "rg-legend", ctx.size === "large" ? center : root);
      const rows = STATUS_KEYS.map((k) => {
        const row = el("div", `rg-lrow ${k}`, list);
        el("i", "", row);
        const name = el("span", "rg-lname", row);
        const val = el("span", "rg-lval", row);
        return { k, row, name, val };
      });
      const set = setter();
      const at = attrSetter();
      return {
        update(d) {
          const v = statusView(d);
          for (const a of arcs) {
            at(a.arc, "stroke-dashoffset", (a.C * (1 - v[a.k].frac)).toFixed(2));
            a.arc.classList.toggle("warn", v[a.k].warn);
          }
          for (const r of rows) {
            set(r.name, r.k === "bat" && v.bat.note ? `${v.bat.label} · ${v.bat.note}` : v[r.k].label);
            set(r.val, v[r.k].text);
            r.row.classList.toggle("warn", v[r.k].warn);
          }
          // 小、中：圆心显示 CPU；大：圆心放三行图例
          set(big, ctx.size === "large" ? "" : v.cpu.text);
          set(bigLabel, ctx.size === "large" ? "" : "CPU");
        },
        destroy: () => root.replaceChildren(),
      };
    },
  },
};

export default ring;
