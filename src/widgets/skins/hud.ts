// 科幻 HUD 主题：切角面板、细发光描边、四角括号角标，偶尔一道很淡的扫光。
// 扫光每 20~40 秒随机来一次、1.4 秒划过，其余时间不产生任何重绘。
import "./hud.css";
import { SIZES, spanPx } from "../types";
import { mmss, pomoButtons, POMO_LABEL, setter, timeText, weekText, pad, el, svg, type Skin } from "./types";

const CUT = 16; // 切角大小（像素）
const ARM = 14; // 角标的臂长

const hud: Skin = {
  id: "hud",
  name: "科幻 HUD",

  frame(host, size) {
    host.classList.add("sk-hud");
    const w = spanPx(SIZES[size].cols);
    const h = spanPx(SIZES[size].rows);
    const body = el("div", "hud-body", host);
    const content = el("div", "sk-content", body);
    const sweep = el("div", "hud-sweep", body);

    // 描边和角标画在形状外面一层，不被裁掉
    const s = svg("svg", { class: "hud-lines", viewBox: `0 0 ${w} ${h}`, width: w, height: h }, host);
    const c = CUT;
    const pts = `${c},0.5 ${w - c},0.5 ${w - 0.5},${c} ${w - 0.5},${h - c} ${w - c},${h - 0.5} ${c},${h - 0.5} 0.5,${h - c} 0.5,${c}`;
    svg("polygon", { class: "hud-edge", points: pts }, s);
    const g = svg("g", { class: "hud-corners" }, s);
    const o = 5; // 角标离边的距离
    for (const [x, y, dx, dy] of [
      [o, o, 1, 1],
      [w - o, o, -1, 1],
      [o, h - o, 1, -1],
      [w - o, h - o, -1, -1],
    ]) {
      // 切角处的括号：沿着斜边外侧，两条短臂
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

  views: {
    clock(root, ctx) {
      root.className = `hud-clock size-${ctx.size}`;
      root.innerHTML = `
        <div class="hud-tag">TIME<span class="hud-tag-sub"></span></div>
        <div class="hud-big"><span class="hud-hm"></span><span class="hud-sec"></span></div>
        <div class="hud-meta"><span class="hud-date"></span><span class="hud-week"></span></div>`;
      const q = (c: string) => root.querySelector(c);
      const set = setter();
      return {
        update(d) {
          const t = timeText(d.now, d.hour12);
          set(q(".hud-hm"), t.hm);
          set(q(".hud-sec"), d.seconds ? t.sec : "");
          set(q(".hud-tag-sub"), t.ampm ? ` // ${t.ampm}` : " // LOCAL");
          set(q(".hud-date"), `${d.now.getFullYear()}.${pad(d.now.getMonth() + 1)}.${pad(d.now.getDate())}`);
          set(q(".hud-week"), weekText(d.now));
        },
        destroy: () => root.replaceChildren(),
      };
    },

    pomodoro(root, ctx) {
      root.className = `hud-pomo size-${ctx.size}`;
      const tag = el("div", "hud-tag", root);
      const big = el("div", "hud-big", root);
      const bar = el("div", "hud-seg", root);
      const N = ctx.size === "small" ? 12 : 24;
      const segs = Array.from({ length: N }, () => el("i", "", bar));
      const btns = el("div", "hud-btns", root);
      const buttons = pomoButtons(btns, ctx, "hud-btn", ctx.size === "small" ? 1 : 2);
      const set = setter();
      let lit = -1;
      return {
        update(d) {
          root.dataset.phase = d.phase;
          set(tag, `FOCUS // ${POMO_LABEL[d.phase]}`);
          set(big, d.phase === "done" ? "DONE" : mmss(d.remainingMs));
          // 分段条：还剩多少格亮着
          const n = Math.ceil((d.remainingMs / d.totalMs) * N);
          if (n !== lit) {
            lit = n;
            segs.forEach((s, i) => s.classList.toggle("on", i < n));
          }
          buttons(d.phase, (t) => `[ ${t} ]`);
        },
        destroy: () => root.replaceChildren(),
      };
    },
  },
};

export default hud;
