import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Animator, Spring } from "./spring";
import { SPRING, fpsReporter } from "./motion";
import { initMusic, musicActive, onExpandChange as musicExpand } from "./music";
import { initPomodoro, pomoPhase, onExpandChange as pomoExpand } from "./pomodoro";
import { alertLevel, initAlerts, type Level } from "./alerts";

// 窗口本身固定大小，胶囊的形变只在页面里做
const TOP = 8;
const COMPACT_H = 34;
const STRIP_H = 38;
const EXPANDED_R = 30;
// 收起时各种内容对应的宽度
const COMPACT_W = { cTime: 120, cMusic: 168, cPomo: 124, cDone: 140, cAlert: 150 };
// 展开时主卡片的大小，底部条往下叠加
const MAIN = { eTime: { w: 340, h: 96 }, eMusic: { w: 384, h: 124 } };
// 鼠标判定区比胶囊略大一点，边缘不至于来回抖
const HIT_PAD = 4;
// 移开后稍等再收回，防止擦边划过时闪一下
const COLLAPSE_DELAY = 120;
// 新警告出现时，收起状态下先显示几秒文字
const ALERT_TOAST_MS = 5000;

type CompactKey = keyof typeof COMPACT_W;
type MainKey = keyof typeof MAIN;
type StripKey = "sPomo" | "sWarn";
type Shape = { w: number; h: number; r: number };

const island = document.getElementById("island")!;
const halo = document.getElementById("halo")!;
const flash = document.getElementById("flash")!;
const tint = island.querySelector<HTMLElement>(".tint")!;
const fpsEl = document.getElementById("fps")!;
const el = (cls: string) => island.querySelector<HTMLElement>("." + cls.replace(/[A-Z]/, (c) => "-" + c.toLowerCase()))!;

// 弹簧参数和架子共用（见 motion.ts）
const shapeCfg = SPRING.shape;
const fadeCfg = SPRING.fade;
const slideCfg = SPRING.slide;

const animator = new Animator(render, fpsReporter(fpsEl));
const w = animator.add(new Spring(COMPACT_W.cTime, shapeCfg));
const h = animator.add(new Spring(COMPACT_H, shapeCfg));
const r = animator.add(new Spring(COMPACT_H / 2, shapeCfg));
const pExpand = animator.add(new Spring(0, fadeCfg)); // 0 收起 → 1 展开
const pWarn = animator.add(new Spring(0, fadeCfg)); // 警告底色

// 每个内容层一个"出现程度"弹簧，切换内容就是交叉淡入淡出
const compactLayers = (Object.keys(COMPACT_W) as CompactKey[]).map((k) => ({
  key: k,
  el: el(k),
  p: animator.add(new Spring(k === "cTime" ? 1 : 0, fadeCfg)),
}));
const mainLayers = (Object.keys(MAIN) as MainKey[]).map((k) => ({
  key: k,
  el: el(k),
  p: animator.add(new Spring(k === "eTime" ? 1 : 0, fadeCfg)),
}));
const stripLayers = (["sPomo", "sWarn"] as StripKey[]).map((k) => ({
  key: k,
  el: el(k),
  p: animator.add(new Spring(0, fadeCfg)),
  y: animator.add(new Spring(MAIN.eTime.h, slideCfg)), // 在胶囊里的纵向位置
}));

let expanded = false;
let alertToast = false;
let collapseTimer: number | undefined;
let toastTimer: number | undefined;

// ---------- 现在该显示什么 ----------
function compactKey(): CompactKey {
  const phase = pomoPhase();
  if (phase === "done") return "cDone";
  if (alertToast) return "cAlert";
  if (phase === "running" || phase === "paused") return "cPomo";
  return musicActive() ? "cMusic" : "cTime";
}
const mainKey = (): MainKey => (musicActive() ? "eMusic" : "eTime");
// 番茄钟条一直在（空闲时就是"开始"按钮），有警告时再加一条
const strips = (): StripKey[] => (alertLevel() === "none" ? ["sPomo"] : ["sPomo", "sWarn"]);

function targetShape(): Shape {
  if (!expanded) return { w: COMPACT_W[compactKey()], h: COMPACT_H, r: COMPACT_H / 2 };
  const m = MAIN[mainKey()];
  return { w: m.w, h: m.h + strips().length * STRIP_H, r: EXPANDED_R };
}

// 任何状态变化都走这里：定下目标，弹簧自己追过去
function retarget() {
  const s = targetShape();
  w.target = s.w;
  h.target = s.h;
  r.target = s.r;
  pExpand.target = expanded ? 1 : 0;
  pWarn.target = alertLevel() === "none" ? 0 : 1;

  const ck = compactKey();
  compactLayers.forEach((l) => (l.p.target = l.key === ck ? 1 : 0));
  const mk = mainKey();
  mainLayers.forEach((l) => (l.p.target = l.key === mk ? 1 : 0));
  const list = strips();
  stripLayers.forEach((l) => {
    const i = list.indexOf(l.key);
    l.p.target = i >= 0 ? 1 : 0;
    if (i >= 0) {
      const y = MAIN[mk].h + i * STRIP_H;
      // 刚出现的条直接放到位，只做淡入；已经在的条才滑动
      if (l.p.value < 0.01) l.y.value = y;
      l.y.target = y;
    }
  });

  sendHitRect(s);
  animator.kick();
}

// ---------- 每帧绘制：只改 transform / opacity / 尺寸 ----------
const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

function setLayer(node: HTMLElement, alpha: number, transform: string) {
  // 几乎看不见的层直接隐藏，省掉绘制，也不挡按钮
  const visible = alpha > 0.01;
  node.style.visibility = visible ? "visible" : "hidden";
  if (!visible) return;
  node.style.opacity = String(alpha);
  node.style.transform = transform;
}

function render() {
  const x = (window.innerWidth - w.value) / 2;
  const geo = `translate3d(${x}px, ${TOP}px, 0)`;
  for (const node of [island, halo, flash]) {
    node.style.transform = geo;
    node.style.width = `${w.value}px`;
    node.style.height = `${h.value}px`;
    node.style.borderRadius = `${r.value}px`;
  }
  const warn = clamp01(pWarn.value);
  tint.style.opacity = String(warn);
  halo.style.opacity = String(warn);

  const e = clamp01(pExpand.value);
  // 收起层比展开层先消失，展开层稍晚出现，避免两层内容叠在一起
  const cAlpha = clamp01(1 - e * 1.6);
  const eAlpha = clamp01(e * 1.4 - 0.4);
  const cScale = `scale(${1 - e * 0.08})`;
  const eMove = `translate3d(0, ${(1 - e) * -6}px, 0) scale(${0.94 + e * 0.06})`;

  for (const l of compactLayers) setLayer(l.el, cAlpha * clamp01(l.p.value), cScale);
  for (const l of mainLayers) setLayer(l.el, eAlpha * clamp01(l.p.value), eMove);
  for (const l of stripLayers) {
    setLayer(l.el, eAlpha * clamp01(l.p.value), `translate3d(0, ${l.y.value + (1 - e) * -6}px, 0)`);
  }
}

// ---------- 提醒：描边闪几下 + 胶囊弹一下 ----------
function pulse(kind: "done" | Level) {
  const rgb = getComputedStyle(document.documentElement).getPropertyValue(`--c-${kind}`).trim();
  flash.style.setProperty("--flash", rgb || "var(--c-done)");
  flash.getAnimations().forEach((a) => a.cancel());
  flash.animate(
    [{ opacity: 0 }, { opacity: 1 }, { opacity: 0.15 }, { opacity: 1 }, { opacity: 0.15 }, { opacity: 1 }, { opacity: 0 }],
    { duration: 1600, easing: "ease-in-out" },
  );
  // 给形状弹簧一个冲量，像被敲了一下
  w.velocity += 260;
  h.velocity += 90;
  animator.kick();
}

function onAlertRaised(level: Level) {
  pulse(level);
  alertToast = true;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    alertToast = false;
    retarget();
  }, ALERT_TOAST_MS);
  retarget();
}

// ---------- 鼠标悬停 ----------
function setExpanded(next: boolean) {
  if (next === expanded) return;
  expanded = next;
  musicExpand(next);
  pomoExpand(next);
  retarget();
}

// 告诉 Rust 哪一块区域算"在胶囊上"，用目标形态而不是动画中途的形态
function sendHitRect(s: Shape) {
  const rect = {
    x: (window.innerWidth - s.w) / 2 - HIT_PAD,
    y: TOP - HIT_PAD,
    w: s.w + HIT_PAD * 2,
    h: s.h + HIT_PAD * 2,
  };
  invoke("set_hit_rect", { rect }).catch(() => {});
}

listen<boolean>("island-hover", (e) => {
  window.clearTimeout(collapseTimer);
  if (e.payload) setExpanded(true);
  else collapseTimer = window.setTimeout(() => setExpanded(false), COLLAPSE_DELAY);
});

// ---------- 双击灵动岛：回到桌面 / 全部最小化（做什么在托盘"双击灵动岛"里选） ----------
// 双击按钮（播放、番茄钟……）不算，那是在连点按钮
island.addEventListener("dblclick", (e) => {
  if ((e.target as Element).closest("button")) return;
  window.getSelection()?.removeAllRanges();
  invoke("island_double_click").catch(() => {});
});

// ---------- 时钟：只在整分钟时更新一次 ----------
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const timeEls = document.querySelectorAll<HTMLElement>(".js-time");
const dateEl = document.querySelector<HTMLElement>(".js-date")!;

function updateClock() {
  const d = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  timeEls.forEach((t) => (t.textContent = hm));
  dateEl.textContent = `${d.getMonth() + 1}月${d.getDate()}日 星期${WEEK[d.getDay()]}`;
  const msToNextMinute = 60_000 - (d.getSeconds() * 1000 + d.getMilliseconds()) + 30;
  window.setTimeout(updateClock, msToNextMinute);
}

// ---------- 配置文件里的颜色 ----------
interface Config {
  color_background: string;
  color_text: string;
  color_glow: string;
  color_battery: string;
  color_gpu: string;
  color_done: string;
}

// 把任意 CSS 颜色转成 "r, g, b"，方便配不同透明度
function toRgbTriplet(color: string) {
  const probe = document.createElement("i");
  probe.style.color = color;
  document.body.appendChild(probe);
  const m = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g);
  probe.remove();
  return m ? m.slice(0, 3).join(", ") : "";
}

function applyConfig(cfg: Config) {
  const root = document.documentElement.style;
  const valid = (c: string) => typeof c === "string" && CSS.supports("color", c);
  // 写错的颜色直接忽略，保留默认值
  if (valid(cfg.color_background)) root.setProperty("--bg", cfg.color_background);
  if (valid(cfg.color_text)) root.setProperty("--text", cfg.color_text);
  if (valid(cfg.color_glow)) root.setProperty("--glow", cfg.color_glow);
  for (const [k, v] of [["battery", cfg.color_battery], ["gpu", cfg.color_gpu], ["done", cfg.color_done]]) {
    if (valid(v)) root.setProperty(`--c-${k}`, toRgbTriplet(v));
  }
}

invoke<Config>("config_get").then(applyConfig).catch(() => {});

// 全屏程序退出、灵动岛重新出现时：如果番茄钟在隐藏期间结束了，补闪一次
listen("island-visible", () => {
  if (pomoPhase() === "done") pulse("done");
});

updateClock();
initMusic(retarget);
initPomodoro(retarget, () => pulse("done"));
initAlerts(retarget, onAlertRaised);
retarget();
window.addEventListener("resize", () => {
  render();
  sendHitRect(targetShape());
});
