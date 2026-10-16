// 番茄钟：和灵动岛是同一个计时器（计时在 Rust 里，广播 pomodoro 事件），哪边操作两边一起变。
// 运行中每秒推一次剩余时间，其余状态只在变化时推。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { WidgetModule } from "../types";
import type { PomoData, PomoPhase } from "../skins/types";

interface PomoState {
  phase: PomoPhase;
  totalMs: number;
  endAt: number;
  remainingMs: number;
}

const pomodoro: WidgetModule<PomoData> = {
  kind: "pomodoro",
  name: "番茄钟",
  sizes: ["small", "medium", "large"],
  defaultSize: "small",

  model() {
    let st: PomoState = { phase: "idle", totalMs: 25 * 60_000, endAt: 0, remainingMs: 25 * 60_000 };
    let paused = false;
    let timer = 0;
    const subs: ((d: PomoData) => void)[] = [];

    const left = () =>
      st.phase === "running" ? Math.max(0, st.endAt - Date.now()) : st.phase === "paused" ? st.remainingMs : st.phase === "done" ? 0 : st.totalMs;

    function push() {
      window.clearTimeout(timer);
      const l = left();
      subs.forEach((cb) => cb({ phase: st.phase, totalMs: st.totalMs, remainingMs: l }));
      if (st.phase === "running" && !paused) timer = window.setTimeout(push, (l % 1000) + 10);
    }

    function apply(next: PomoState) {
      st = next;
      push();
    }

    const act = (action: string) => {
      invoke<PomoState>("pomodoro_cmd", { action }).then(apply).catch(() => {});
    };
    const unlisten = listen<PomoState>("pomodoro", (e) => apply(e.payload));
    unlisten.then(() => act("get"));

    return {
      subscribe(cb) {
        subs.push(cb);
        cb({ phase: st.phase, totalMs: st.totalMs, remainingMs: left() });
      },
      act,
      setPaused(p) {
        paused = p;
        push();
      },
      destroy() {
        window.clearTimeout(timer);
        subs.length = 0;
        unlisten.then((f) => f());
      },
    };
  },
};

export default pomodoro;
