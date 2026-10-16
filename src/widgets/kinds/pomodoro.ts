// 番茄钟：和灵动岛是同一个计时器（计时在 Rust 里，广播 pomodoro 事件），哪边操作两边一起变。
// 运行中一秒更新一次圆环和数字，其余状态完全不动。
import "./pomodoro.css";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SizeKey, WidgetModule } from "../types";

type Phase = "idle" | "running" | "paused" | "done";

interface PomoState {
  phase: Phase;
  totalMs: number;
  endAt: number;
  remainingMs: number;
}

const R = 44;
const C = 2 * Math.PI * R;

function fmt(ms: number) {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const LABEL: Record<Phase, string> = {
  idle: "准备专注",
  running: "专注中",
  paused: "已暂停",
  done: "专注完成",
};

/** 每个状态下的两个按钮：[文字, 动作] */
const BUTTONS: Record<Phase, [string, string][]> = {
  idle: [["开始", "start"]],
  running: [
    ["暂停", "pause"],
    ["结束", "cancel"],
  ],
  paused: [
    ["继续", "resume"],
    ["结束", "cancel"],
  ],
  done: [
    ["再来一轮", "start"],
    ["好的", "dismiss"],
  ],
};

const pomodoro: WidgetModule = {
  kind: "pomodoro",
  name: "番茄钟",
  sizes: ["small", "medium", "large"],
  defaultSize: "small",

  create(root, opts) {
    let size: SizeKey = opts.size;
    let st: PomoState = { phase: "idle", totalMs: 25 * 60_000, endAt: 0, remainingMs: 25 * 60_000 };
    let paused = false;
    let timer = 0;
    let lastText = "";
    let el: Record<string, HTMLElement | SVGElement> = {};
    const unlisten: Promise<UnlistenFn> = listen<PomoState>("pomodoro", (e) => apply(e.payload));

    function build() {
      root.className = `w-pomo size-${size}`;
      root.innerHTML = `
        <div class="po-ring">
          <svg viewBox="0 0 100 100">
            <circle class="po-track" cx="50" cy="50" r="${R}" />
            <circle class="po-arc" cx="50" cy="50" r="${R}" stroke-dasharray="${C}" />
          </svg>
          <div class="po-center"><div class="po-time"></div><div class="po-label"></div></div>
        </div>
        <div class="po-side">
          <div class="po-state"></div>
          <div class="po-btns"></div>
        </div>`;
      el = {
        arc: root.querySelector(".po-arc")!,
        time: root.querySelector(".po-time")!,
        label: root.querySelector(".po-label")!,
        state: root.querySelector(".po-state")!,
        btns: root.querySelector(".po-btns")!,
      };
      lastText = "";
      render();
    }

    function remaining() {
      if (st.phase === "running") return Math.max(0, st.endAt - Date.now());
      if (st.phase === "paused") return st.remainingMs;
      if (st.phase === "done") return 0;
      return st.totalMs;
    }

    function render() {
      window.clearTimeout(timer);
      root.dataset.phase = st.phase;
      const left = remaining();
      const text = fmt(left);
      if (text !== lastText) {
        lastText = text;
        el.time.textContent = st.phase === "done" ? "完成" : text;
      }
      // 圆环：剩下的部分
      const frac = st.totalMs > 0 ? left / st.totalMs : 0;
      el.arc.setAttribute("stroke-dashoffset", String(C * (1 - frac)));
      const mins = Math.round(st.totalMs / 60_000);
      el.label.textContent = st.phase === "idle" ? `${mins} 分钟` : LABEL[st.phase];
      el.state.textContent = st.phase === "idle" ? `专注 ${mins} 分钟` : LABEL[st.phase];
      buttons();
      if (st.phase === "running" && !paused) timer = window.setTimeout(render, (left % 1000) + 10);
    }

    let lastPhase: Phase | null = null;
    function buttons() {
      if (lastPhase === st.phase) return;
      lastPhase = st.phase;
      el.btns.replaceChildren();
      const list = size === "small" ? BUTTONS[st.phase].slice(0, 1) : BUTTONS[st.phase];
      for (const [label, action] of list) {
        const b = document.createElement("button");
        b.className = "po-btn" + (action === list[0][1] ? " primary" : "");
        b.textContent = label;
        b.addEventListener("click", () => act(action));
        el.btns.appendChild(b);
      }
    }

    function apply(next: PomoState) {
      st = next;
      render();
    }

    function act(action: string) {
      invoke<PomoState>("pomodoro_cmd", { action }).then(apply).catch(() => {});
    }

    build();
    unlisten.then(() => act("get"));

    return {
      setSize(s) {
        if (s === size) return;
        size = s;
        lastPhase = null;
        build();
      },
      setPaused(p) {
        paused = p;
        render();
      },
      destroy() {
        window.clearTimeout(timer);
        unlisten.then((f) => f());
        root.replaceChildren();
      },
    };
  },
};

export default pomodoro;
