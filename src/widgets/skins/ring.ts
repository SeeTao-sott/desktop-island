// 圆环主题：组件是圆形（中尺寸是胶囊形：左边圆、右边信息）。
// 时钟外圈 60 格发光刻度，走过的分钟（开了秒就是秒）亮起来；
// 番茄钟像游戏技能冷却：圆盘上一块暗色扇形，随时间顺时针退去，边上一根亮线。
import "./ring.css";
import { mmss, pomoButtons, POMO_LABEL, setter, timeText, dateText, weekText, el, svg, type Skin } from "./types";

const ring: Skin = {
  id: "ring",
  name: "圆环",

  frame(host, size) {
    host.classList.add("sk-ring", `rg-${size}`);
    const body = el("div", "rg-body", host);
    const content = el("div", "sk-content", body);
    return { content, frame: { setPaused() {}, destroy: () => body.remove() } };
  },

  views: {
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
        const line = svg("line", {
          x1: 50 + Math.sin(a) * r1,
          y1: 50 - Math.cos(a) * r1,
          x2: 50 + Math.sin(a) * r2,
          y2: 50 - Math.cos(a) * r2,
          class: major ? "major" : "",
        });
        dim.appendChild(line);
        ticks.push(line);
      }
      const center = el("div", "rg-center", dial);
      const hm = el("div", "rg-hm", center);
      const small = el("div", "rg-small", center);
      const side = el("div", "rg-side", root);
      const day = el("div", "rg-day", side);
      const week = el("div", "rg-week", side);
      const set = setter();
      let litCount = -1;
      return {
        update(d) {
          const t = timeText(d.now, d.hour12);
          set(hm, t.hm);
          set(small, ctx.size === "medium" ? (d.seconds ? t.sec : t.ampm) : d.seconds ? t.sec : dateText(d.now));
          set(day, dateText(d.now));
          set(week, weekText(d.now));
          // 亮起来的刻度：只在数量变了时搬动（每分钟一次，开了秒就每秒一次）
          const n = (d.seconds ? d.now.getSeconds() : d.now.getMinutes()) + 1;
          if (n !== litCount) {
            litCount = n;
            ticks.forEach((t, i) => (i < n ? lit : dim).appendChild(t));
          }
        },
        destroy: () => root.replaceChildren(),
      };
    },

    pomodoro(root, ctx) {
      root.className = `rg-pomo size-${ctx.size}`;
      const dial = el("div", "rg-dial", root);
      const s = svg("svg", { viewBox: "0 0 100 100", class: "rg-outer" }, dial);
      const R = 47;
      const C = 2 * Math.PI * R;
      svg("circle", { class: "rg-track", cx: 50, cy: 50, r: R }, s);
      const arc = svg("circle", { class: "rg-arc", cx: 50, cy: 50, r: R, "stroke-dasharray": C }, s);
      // 冷却圆盘：暗色扇形 = 还剩的部分；亮线 = 扇形的边
      const cd = el("div", "rg-cd", dial);
      const hand = el("div", "rg-hand", cd);
      const center = el("div", "rg-center", dial);
      const time = el("div", "rg-hm", center);
      const label = el("div", "rg-small", center);
      const side = el("div", "rg-side", root);
      const state = el("div", "rg-state", side);
      const btns = el("div", "rg-btns", ctx.size === "small" ? center : side);
      const buttons = pomoButtons(btns, ctx, "rg-btn", ctx.size === "small" ? 1 : 2);
      const set = setter();
      return {
        update(d) {
          root.dataset.phase = d.phase;
          const left = d.totalMs > 0 ? d.remainingMs / d.totalMs : 0;
          const passed = (1 - left) * 360;
          cd.style.setProperty("--passed", `${passed}deg`);
          hand.style.transform = `rotate(${passed}deg)`;
          hand.hidden = d.phase === "idle" || d.phase === "done";
          arc.setAttribute("stroke-dashoffset", String(C * (1 - left)));
          set(time, d.phase === "done" ? "就绪" : mmss(d.remainingMs));
          set(label, POMO_LABEL[d.phase]);
          set(state, POMO_LABEL[d.phase]);
          buttons(d.phase);
        },
        destroy: () => root.replaceChildren(),
      };
    },
  },
};

export default ring;
