// 方形主题：现在的圆角玻璃卡片
import "./square.css";
import { mmss, pomoButtons, POMO_LABEL, setter, timeText, dateText, weekText, el, svg, type Skin } from "./types";

const R = 44;
const C = 2 * Math.PI * R;

const square: Skin = {
  id: "square",
  name: "方形",

  frame(host) {
    host.classList.add("sk-square");
    const body = el("div", "sq-body", host);
    const content = el("div", "sk-content", body);
    return { content, frame: { setPaused() {}, destroy: () => body.remove() } };
  },

  views: {
    clock(root, ctx) {
      root.className = `sq-clock size-${ctx.size}`;
      root.innerHTML = `<div class="sq-time"><span class="sq-ampm"></span><span class="sq-hm"></span><span class="sq-sec"></span></div>
        <div class="sq-date"><span class="sq-day"></span><span class="sq-week"></span></div>`;
      const set = setter();
      const q = (c: string) => root.querySelector(c);
      return {
        update(d) {
          const t = timeText(d.now, d.hour12);
          set(q(".sq-ampm"), t.ampm);
          set(q(".sq-hm"), t.hm);
          set(q(".sq-sec"), d.seconds ? t.sec : "");
          set(q(".sq-day"), dateText(d.now));
          set(q(".sq-week"), weekText(d.now));
        },
        destroy: () => root.replaceChildren(),
      };
    },

    pomodoro(root, ctx) {
      root.className = `sq-pomo size-${ctx.size}`;
      const ring = el("div", "sq-ring", root);
      const s = svg("svg", { viewBox: "0 0 100 100" }, ring);
      svg("circle", { class: "sq-track", cx: 50, cy: 50, r: R }, s);
      const arc = svg("circle", { class: "sq-arc", cx: 50, cy: 50, r: R, "stroke-dasharray": C }, s);
      const center = el("div", "sq-center", ring);
      const time = el("div", "sq-ptime", center);
      const side = el("div", "sq-side", root);
      const label = el("div", "sq-state", side);
      const btns = el("div", "sq-btns", side);
      const buttons = pomoButtons(btns, ctx, "sq-btn", ctx.size === "small" ? 1 : 2);
      const set = setter();
      return {
        update(d) {
          root.dataset.phase = d.phase;
          set(time, d.phase === "done" ? "完成" : mmss(d.remainingMs));
          set(label, POMO_LABEL[d.phase]);
          arc.setAttribute("stroke-dashoffset", String(C * (1 - d.remainingMs / d.totalMs)));
          buttons(d.phase);
        },
        destroy: () => root.replaceChildren(),
      };
    },
  },
};

export default square;
