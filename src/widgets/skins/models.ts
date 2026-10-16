// 组件的数据源：时钟按秒（或按分钟）走；番茄钟这里是预览用的"模拟计时"，不碰真正的番茄钟。
import type { ClockData, PomoData } from "./types";

/** 时钟：对准整秒（显示秒时）或整分钟醒来，回调新数据 */
export function clockTicker(opts: { seconds: boolean; hour12: boolean }, cb: (d: ClockData) => void) {
  let timer = 0;
  let paused = false;
  const tick = () => {
    const now = new Date();
    cb({ now, ...opts });
    window.clearTimeout(timer);
    if (paused) return;
    const ms = opts.seconds ? 1000 - now.getMilliseconds() : 60_000 - now.getSeconds() * 1000 - now.getMilliseconds();
    timer = window.setTimeout(tick, ms + 15);
  };
  tick();
  return {
    setPaused(p: boolean) {
      paused = p;
      if (p) window.clearTimeout(timer);
      else tick();
    },
    stop() {
      window.clearTimeout(timer);
    },
  };
}

/** 预览用的番茄钟：从 25 分钟里剩 18:42 开始倒数，按钮在预览里也能点 */
export function fakePomodoro(cb: (d: PomoData) => void) {
  const totalMs = 25 * 60_000;
  let phase: PomoData["phase"] = "running";
  let endAt = Date.now() + (18 * 60 + 42) * 1000;
  let remaining = 0;
  let timer = 0;
  const left = () => (phase === "running" ? Math.max(0, endAt - Date.now()) : phase === "paused" ? remaining : phase === "done" ? 0 : totalMs);
  const tick = () => {
    window.clearTimeout(timer);
    if (phase === "running" && left() <= 0) phase = "done";
    const l = left();
    cb({ phase, totalMs, remainingMs: l });
    if (phase === "running") timer = window.setTimeout(tick, (l % 1000) + 10);
  };
  const act = (a: string) => {
    if (a === "start") {
      phase = "running";
      endAt = Date.now() + totalMs;
    } else if (a === "pause" && phase === "running") {
      remaining = left();
      phase = "paused";
    } else if (a === "resume" && phase === "paused") {
      endAt = Date.now() + remaining;
      phase = "running";
    } else if (a === "cancel" || a === "dismiss") {
      phase = "idle";
    }
    tick();
  };
  tick();
  return { act, stop: () => window.clearTimeout(timer) };
}
