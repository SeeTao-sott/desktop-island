import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Phase = "idle" | "running" | "paused" | "done";

interface PomoState {
  phase: Phase;
  totalMs: number;
  endAt: number; // 运行中：结束时刻（Unix 毫秒）
  remainingMs: number; // 暂停中：剩余毫秒
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const compactLeft = $(".js-pomo-left");
const stripText = $(".js-pomo-text");
const btnA = $<HTMLButtonElement>(".js-pomo-a");
const btnB = $<HTMLButtonElement>(".js-pomo-b");

let state: PomoState = { phase: "idle", totalMs: 25 * 60_000, endAt: 0, remainingMs: 25 * 60_000 };
let tickTimer: number | undefined;
let seenDone = false;
let hooks = { changed: () => {}, finished: () => {} };

export const pomoPhase = () => state.phase;

function remaining() {
  if (state.phase === "running") return Math.max(0, state.endAt - Date.now());
  if (state.phase === "paused") return state.remainingMs;
  return state.totalMs;
}

function fmt(ms: number) {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// 文字只在秒数变化时更新；计时本身在 Rust 里，这里只负责显示
function render() {
  window.clearTimeout(tickTimer);
  const left = fmt(remaining());
  compactLeft.textContent = left;
  const mins = Math.round(state.totalMs / 60_000);

  switch (state.phase) {
    case "idle":
      stripText.textContent = `专注 ${mins} 分钟`;
      setButtons(["开始", "start"]);
      break;
    case "running":
      stripText.textContent = `专注中 · ${left}`;
      setButtons(["暂停", "pause"], ["结束", "cancel"]);
      // 对齐到下一个整秒再刷新
      tickTimer = window.setTimeout(render, (remaining() % 1000) + 5);
      break;
    case "paused":
      stripText.textContent = `已暂停 · ${left}`;
      setButtons(["继续", "resume"], ["结束", "cancel"]);
      break;
    case "done":
      stripText.textContent = "专注完成，休息一下吧";
      setButtons(["再来一轮", "start"]);
      break;
  }
  document.body.dataset.pomo = state.phase;
}

function setButtons(a: [string, string], b?: [string, string]) {
  btnA.textContent = a[0];
  btnA.dataset.action = a[1];
  btnB.hidden = !b;
  if (b) {
    btnB.textContent = b[0];
    btnB.dataset.action = b[1];
  }
}

function apply(next: PomoState) {
  const prevPhase = state.phase;
  state = next;
  if (next.phase !== "done") seenDone = false;
  render();
  if (prevPhase !== next.phase) {
    hooks.changed();
    if (next.phase === "done" && prevPhase === "running") hooks.finished();
  }
}

function act(action: string) {
  invoke<PomoState>("pomodoro_cmd", { action }).then(apply).catch(() => {});
}

// 展开时看到了"完成"，收起后就回到平时状态
export function onExpandChange(expanded: boolean) {
  if (state.phase !== "done") return;
  if (expanded) seenDone = true;
  else if (seenDone) act("dismiss");
}

export function initPomodoro(changed: () => void, finished: () => void) {
  hooks = { changed, finished };
  for (const b of [btnA, btnB]) b.addEventListener("click", () => act(b.dataset.action!));
  render();
  listen<PomoState>("pomodoro", (e) => apply(e.payload)).then(() => act("get"));
}
