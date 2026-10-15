// 架子底部的操作提示：成功的带"撤销"按钮（10 秒），失败的说清楚原因
import { api, type OpResult } from "./shelf-api";

const UNDO_MS = 10_000;
const ERROR_MS = 8_000;

const box = document.getElementById("toasts")!;
let holding = 0;

function hold(delta: number) {
  const before = holding > 0;
  holding = Math.max(0, holding + delta);
  if (before !== holding > 0) api.hold(holding > 0);
}

function show(text: string, opts: { undo?: () => void; error?: boolean; ms: number }) {
  const el = document.createElement("div");
  el.className = "toast" + (opts.error ? " error" : "");
  const msg = document.createElement("span");
  msg.className = "toast-text";
  msg.textContent = text;
  el.appendChild(msg);

  let timer = 0;
  const close = () => {
    window.clearTimeout(timer);
    if (!el.isConnected) return;
    el.classList.add("leaving");
    window.setTimeout(() => el.remove(), 220);
    if (opts.undo) hold(-1);
  };

  if (opts.undo) {
    const btn = document.createElement("button");
    btn.className = "toast-undo";
    btn.textContent = "撤销";
    btn.addEventListener("click", () => {
      close();
      opts.undo!();
    });
    el.appendChild(btn);
    // 倒计时细条：交给 CSS 动画，由合成器负责
    const bar = document.createElement("i");
    bar.className = "toast-bar";
    bar.style.animationDuration = `${opts.ms}ms`;
    el.appendChild(bar);
    hold(1);
  } else {
    const x = document.createElement("button");
    x.className = "toast-close";
    x.textContent = "×";
    x.addEventListener("click", close);
    el.appendChild(x);
  }

  box.appendChild(el);
  // 最多同时显示 3 条
  while (box.children.length > 3) (box.firstElementChild as HTMLElement).remove();
  timer = window.setTimeout(close, opts.ms);
}

const VERB: Record<OpResult["kind"], string> = {
  put: "已放进",
  move: "已移到",
  rename: "已改名为",
  remove: "已移到「已移除」",
  undo: "已撤销",
  "rename-category": "分类已改名为",
  "remove-category": "已移到「已移除」",
  migrate: "已从桌面搬进",
  restore: "已搬回桌面",
};

/** 根据一次操作的结果显示提示；onUndo 由调用方提供（撤销后刷新等） */
export function reportOp(r: OpResult, onUndo: (opId: number) => void) {
  const n = r.moved.length;
  if (n > 0) {
    let text: string;
    const first = r.moved[0];
    const where = (p: string) => p.split("\\").slice(-2, -1)[0];
    if (r.kind === "remove") text = n === 1 ? `「${first.name}」${VERB.remove}` : `${n} 项${VERB.remove}`;
    else if (r.kind === "rename") text = `${VERB.rename}「${first.name}」`;
    else if (r.kind === "rename-category") text = `${VERB["rename-category"]}「${first.name}」`;
    else if (r.kind === "remove-category") text = `分类「${first.name}」${VERB["remove-category"]}`;
    else if (r.kind === "restore") text = n === 1 ? `「${first.name}」${VERB.restore}` : `${n} 项${VERB.restore}`;
    else if (r.kind === "undo") text = n === 1 ? `${VERB.undo}，「${first.name}」已放回原处` : `${VERB.undo}，${n} 项已放回原处`;
    else {
      const cats = [...new Set(r.moved.map((m) => where(m.to)))];
      const target = cats.length === 1 ? `「${cats[0]}」` : "架子";
      text = n === 1 ? `「${first.name}」${VERB[r.kind]}${target}` : `${n} 项${VERB[r.kind]}${target}`;
    }
    const opId = r.opId;
    show(text, { ms: UNDO_MS, undo: opId != null ? () => onUndo(opId) : undefined });
  }
  if (r.failed.length > 0) {
    const lines = r.failed.slice(0, 3).map((f) => f.reason);
    if (r.failed.length > 3) lines.push(`还有 ${r.failed.length - 3} 项也没成功`);
    showError(lines.join("\n"));
  }
}

export function showError(text: string) {
  show(text, { error: true, ms: ERROR_MS });
}
