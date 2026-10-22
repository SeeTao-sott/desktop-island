// 手柄按键显示：Rust 用 XInput 读手柄，变了就发一帧过来；这里只是把按下的键点亮、摇杆帽挪过去、扳机填满。
// 窗口点击穿透、不抢焦点，玩别的游戏时浮在屏幕角落。颜色跟壁纸的主题色。
import { listen } from "@tauri-apps/api/event";
import { initTheme } from "../widgets/theme";

interface PadState {
  slot: number;
  buttons: number;
  lt: number;
  rt: number;
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  /** 电量 0~3；有线或读不到时是 null */
  battery: number | null;
}

/** XInput 的按键位 */
const L_THUMB = 0x40;
const R_THUMB = 0x80;
/** 摇杆帽最多偏多远（SVG 单位） */
const REACH = 11;

const btns = [...document.querySelectorAll<SVGElement>("[data-bit]")].map((el) => ({ el, bit: Number(el.dataset.bit) }));
const ltFill = document.querySelector<SVGElement>("#lt .fill")!;
const rtFill = document.querySelector<SVGElement>("#rt .fill")!;
const ls = document.getElementById("ls")!;
const rs = document.getElementById("rs")!;
const lsCap = ls.querySelector<SVGElement>(".cap")!;
const rsCap = rs.querySelector<SVGElement>(".cap")!;
const battery = document.getElementById("battery")!;
const batBars = [...battery.querySelectorAll<SVGElement>(".bat-bar")];

/** 摇杆：-32768~32767 → 帽子偏移；小于死区的抖动不画 */
function stick(x: number, y: number): string {
  const nx = Math.max(-1, x / 32767);
  const ny = Math.max(-1, y / 32767);
  const m = Math.hypot(nx, ny);
  if (m < 0.08) return "translate(0px, 0px)";
  const k = Math.min(1, m) / m;
  // XInput 的 y 往上为正，屏幕往下为正
  return `translate(${(nx * k * REACH).toFixed(2)}px, ${(-ny * k * REACH).toFixed(2)}px)`;
}

let pending: PadState | null = null;
function draw() {
  const s = pending;
  pending = null;
  if (!s) return;
  for (const { el, bit } of btns) el.classList.toggle("on", (s.buttons & bit) !== 0);
  ltFill.style.transform = `scaleX(${(s.lt / 255).toFixed(3)})`;
  rtFill.style.transform = `scaleX(${(s.rt / 255).toFixed(3)})`;
  lsCap.style.transform = stick(s.lx, s.ly);
  rsCap.style.transform = stick(s.rx, s.ry);
  ls.classList.toggle("on", (s.buttons & L_THUMB) !== 0);
  rs.classList.toggle("on", (s.buttons & R_THUMB) !== 0);
  battery.style.display = s.battery == null ? "none" : "";
  if (s.battery != null) {
    // 0 空、1 低、2 中、3 满 → 亮 0~3 格
    batBars.forEach((b, i) => b.classList.toggle("on", i < s.battery!));
    battery.classList.toggle("low", s.battery <= 1);
  }
}

// 一帧画面最多画一次（Rust 每秒最多发约 120 次）
listen<PadState>("pad-state", (e) => {
  if (!pending) requestAnimationFrame(draw);
  pending = e.payload;
});
initTheme();
