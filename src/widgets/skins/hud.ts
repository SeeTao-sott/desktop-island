// 科幻 HUD 主题：切角面板、细发光描边、四角括号角标，偶尔一道很淡的扫光。
// 扫光每 20~40 秒随机来一次、1.4 秒划过，其余时间不产生任何重绘；全屏时停掉。
import "./hud.css";
import {
  POMO_LABEL,
  STATUS_KEYS,
  attrSetter,
  coverSetter,
  el,
  fmtPos,
  ICON,
  mmss,
  musicButtons,
  pad,
  pomoButtons,
  setter,
  statusView,
  svg,
  timeText,
  weekText,
  type Pt,
  type Skin,
} from "./types";

const CUT = 16; // 切角大小（像素）
const ARM = 14; // 角标的臂长

/** 分段条：n 格，亮多少格由 frac 决定 */
function segments(parent: HTMLElement, n: number, cls = "hud-seg") {
  const bar = el("div", cls, parent);
  const segs = Array.from({ length: n }, () => el("i", "", bar));
  let lit = -1;
  return (frac: number) => {
    const k = Math.round(Math.min(1, Math.max(0, frac)) * n);
    if (k === lit) return;
    lit = k;
    segs.forEach((s, i) => s.classList.toggle("on", i < k));
  };
}

const hud: Skin = {
  id: "hud",
  name: "科幻 HUD",
  grid: "rect",

  frame(host, _size, w, h) {
    host.classList.add("sk-hud");
    const body = el("div", "hud-body", host);
    const content = el("div", "sk-content", body);
    const sweep = el("div", "hud-sweep", body);

    // 描边和角标画在形状外面一层，不被裁掉
    const s = svg("svg", { class: "hud-lines", viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none" }, host);
    const c = CUT;
    const pts = `${c},0.5 ${w - c},0.5 ${w - 0.5},${c} ${w - 0.5},${h - c} ${w - c},${h - 0.5} ${c},${h - 0.5} 0.5,${h - c} 0.5,${c}`;
    svg("polygon", { class: "hud-edge", points: pts }, s);
    const g = svg("g", { class: "hud-corners" }, s);
    const o = 5;
    for (const [x, y, dx, dy] of [
      [o, o, 1, 1],
      [w - o, o, -1, 1],
      [o, h - o, 1, -1],
      [w - o, h - o, -1, -1],
    ]) {
      const ax = x + dx * (c - 4);
      const ay = y + dy * (c - 4);
      svg("polyline", { points: `${x},${ay + dy * ARM} ${x},${ay} ${ax},${y} ${ax + dx * ARM},${y}` }, g);
    }

    let timer = 0;
    let paused = false;
    const schedule = () => {
      window.clearTimeout(timer);
      if (paused) return;
      timer = window.setTimeout(() => {
        sweep.classList.remove("go");
        void sweep.offsetWidth;
        sweep.classList.add("go");
        schedule();
      }, 20_000 + Math.random() * 20_000);
    };
    sweep.addEventListener("animationend", () => sweep.classList.remove("go"));
    schedule();

    return {
      content,
      frame: {
        setPaused(p) {
          paused = p;
          if (p) {
            window.clearTimeout(timer);
            sweep.classList.remove("go");
          } else schedule();
        },
        destroy() {
          window.clearTimeout(timer);
          body.remove();
          s.remove();
        },
      },
    };
  },

  outline(_size, w, h): Pt[] {
    const c = CUT;
    return [
      [c, 0],
      [w - c, 0],
      [w, c],
      [w, h - c],
      [w - c, h],
      [c, h],
      [0, h - c],
      [0, c],
    ];
  },

  views: {
    clock(root, ctx) {
      root.className = `hud-clock size-${ctx.size}`;
      root.innerHTML = `
        <div class="hud-tag">TIME<span class="hud-tag-sub"></span></div>
        <div class="hud-big"><span class="hud-hm"></span><span class="hud-sec"></span></div>
        <div class="hud-meta"><span class="hud-date"></span><span class="hud-week"></span></div>
        ${ctx.size === "large" ? '<div class="hud-minute"><div class="hud-tag">MINUTE // 本小时</div></div>' : ""}`;
      const q = (c: string) => root.querySelector(c);
      const minute = q(".hud-minute") as HTMLElement | null;
      const minuteBar = minute ? segments(minute, 30) : null;
      const set = setter();
      return {
        update(d) {
          const t = timeText(d.now, d.hour12);
          set(q(".hud-hm"), t.hm);
          set(q(".hud-sec"), d.seconds ? t.sec : "");
          set(q(".hud-tag-sub"), t.ampm ? ` // ${t.ampm}` : " // LOCAL");
          set(q(".hud-date"), `${d.now.getFullYear()}.${pad(d.now.getMonth() + 1)}.${pad(d.now.getDate())}`);
          set(q(".hud-week"), weekText(d.now));
          minuteBar?.((d.now.getMinutes() + 1) / 60);
        },
        destroy: () => root.replaceChildren(),
      };
    },

    pomodoro(root, ctx) {
      root.className = `hud-pomo size-${ctx.size}`;
      const tag = el("div", "hud-tag", root);
      const big = el("div", "hud-big", root);
      const bar = segments(root, ctx.size === "small" ? 12 : 24);
      const btns = el("div", "hud-btns", root);
      const buttons = pomoButtons(btns, ctx, "hud-btn", ctx.size === "small" ? 1 : 2);
      const set = setter();
      return {
        update(d) {
          root.dataset.phase = d.phase;
          set(tag, `FOCUS // ${POMO_LABEL[d.phase]}`);
          set(big, d.phase === "done" ? "DONE" : mmss(d.remainingMs));
          bar(d.totalMs > 0 ? d.remainingMs / d.totalMs : 0);
          buttons(d.phase, (t) => `[ ${t} ]`);
        },
        destroy: () => root.replaceChildren(),
      };
    },

    music(root, ctx) {
      root.className = `hud-music size-${ctx.size}`;
      const cov = el("div", "hud-cover", root);
      const img = el("img", "", cov);
      img.alt = "";
      el("span", "hud-ph", cov).innerHTML = ICON.note;
      const cover = coverSetter(img);
      const info = el("div", "hud-info", root);
      const tag = el("div", "hud-tag", info);
      const title = el("div", "hud-title", info);
      const artist = el("div", "hud-artist", info);
      const bar = segments(info, ctx.size === "small" ? 14 : 22);
      const pos = el("div", "hud-pos", info);
      const ctrl = el("div", "hud-ctrl", info);
      const buttons = musicButtons(ctrl, ctx, "hud-mbtn", ctx.size === "small" ? ["toggle", "next"] : ["prev", "toggle", "next"]);
      const set = setter();
      return {
        update(d) {
          root.classList.toggle("active", d.active);
          cover(d.cover);
          set(tag, d.active ? (d.playing ? "NOW PLAYING // 播放中" : "PAUSED // 已暂停") : "AUDIO // 没有在播放");
          bar(d.active && d.durationMs > 0 ? d.positionMs / d.durationMs : 0);
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
      root.className = `hud-status size-${ctx.size}`;
      el("div", "hud-tag", root).textContent = "SYSTEM // 系统状态";
      const rows = STATUS_KEYS.map((k) => {
        const row = el("div", `hud-srow ${k}`, root);
        const name = el("span", "hud-sname", row);
        const bar = segments(row, ctx.size === "small" ? 8 : 16, "hud-seg mini");
        const val = el("span", "hud-sval", row);
        return { k, row, name, bar, val };
      });
      let line: SVGPolylineElement | null = null;
      if (ctx.size === "large") {
        const chart = el("div", "hud-chart", root);
        el("div", "hud-tag", chart).textContent = "CPU // 最近 60 次";
        const s = svg("svg", { viewBox: "0 0 59 100", preserveAspectRatio: "none" }, chart);
        for (const y of [25, 50, 75]) svg("line", { x1: 0, x2: 59, y1: y, y2: y, class: "hud-gridline" }, s);
        line = svg("polyline", {}, s);
      }
      const set = setter();
      const at = attrSetter();
      return {
        update(d) {
          const v = statusView(d);
          for (const r of rows) {
            const x = v[r.k];
            set(r.name, x.label);
            set(r.val, x.text);
            r.bar(x.frac);
            r.row.classList.toggle("warn", x.warn);
          }
          if (line) at(line, "points", d.history.map((p, i) => `${i + (60 - d.history.length)},${(100 - p).toFixed(1)}`).join(" "));
        },
        destroy: () => root.replaceChildren(),
      };
    },
  },
};

export default hud;
