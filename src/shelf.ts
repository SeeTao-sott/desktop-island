import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Animator, Spring } from "./spring";
import { SPRING, fpsReporter } from "./motion";

// 默认分类（阶段 1 先放空的，阶段 2 接上真实文件夹）
const CATEGORIES = [
  { id: "apps", name: "软件", icon: "#c-apps" },
  { id: "docs", name: "文档", icon: "#c-docs" },
  { id: "images", name: "图片", icon: "#c-images" },
  { id: "archives", name: "压缩包", icon: "#c-archives" },
  { id: "other", name: "其他", icon: "#c-other" },
];

/** 面板和窗口右边的空隙（和 CSS 里 .panel 的 right/top 一致） */
const GAP = 10;
/** 收起时面板要滑出窗口外这么远，连阴影一起看不见（宽度按配置会变） */
let HIDDEN_X = 320 + GAP + 34;
/** 滑出时各分类依次跟上的间隔 */
const STAGGER_MS = 28;

interface ShelfState {
  open: boolean;
  pinned: boolean;
}
interface Config {
  shelf_hotkey: string;
  shelf_width: number;
}

const panel = document.getElementById("panel")!;
const list = document.getElementById("list")!;
const search = document.getElementById("search") as HTMLInputElement;
const foot = document.querySelector<HTMLElement>(".js-foot")!;
const tpl = document.getElementById("tpl-section") as HTMLTemplateElement;

const animator = new Animator(render, fpsReporter(document.getElementById("fps")!));
const slide = animator.add(new Spring(HIDDEN_X, SPRING.slide));
const fade = animator.add(new Spring(0, SPRING.fade));

// ---------- 分类 ----------
interface Section {
  el: HTMLElement;
  body: HTMLElement;
  inner: HTMLElement;
  chev: SVGElement;
  height: Spring; // 展开高度
  turn: Spring; // 箭头角度 0 → 1
  enter: Spring; // 滑出时的错落入场
  expanded: boolean;
}

const sections: Section[] = CATEGORIES.map((c, i) => {
  const frag = tpl.content.cloneNode(true) as DocumentFragment;
  const el = frag.querySelector<HTMLElement>(".sec")!;
  el.dataset.id = c.id;
  el.querySelector(".sec-name")!.textContent = c.name;
  el.querySelector(".sec-ic use")!.setAttribute("href", c.icon);
  list.appendChild(frag);
  const s: Section = {
    el,
    body: el.querySelector<HTMLElement>(".sec-body")!,
    inner: el.querySelector<HTMLElement>(".sec-inner")!,
    chev: el.querySelector<SVGElement>(".chev")!,
    height: animator.add(new Spring(0, SPRING.shape)),
    turn: animator.add(new Spring(0, SPRING.shape)),
    enter: animator.add(new Spring(1, SPRING.slide)),
    expanded: false,
  };
  el.querySelector(".sec-head")!.addEventListener("click", () => setExpanded(s, !s.expanded));
  // 第一个分类默认展开
  if (i === 0) setExpanded(s, true, true);
  return s;
});

function setExpanded(s: Section, next: boolean, instant = false) {
  s.expanded = next;
  s.height.target = next ? s.inner.offsetHeight : 0;
  s.turn.target = next ? 1 : 0;
  if (instant) {
    s.height.value = s.height.target;
    s.turn.value = s.turn.target;
  }
  animator.kick();
}

// ---------- 每帧绘制：只改 transform / opacity / 高度 ----------
function render() {
  const hidden = slide.value >= HIDDEN_X - 0.5 && slide.target === HIDDEN_X;
  // 完全收起后直接隐藏，省掉绘制
  panel.style.visibility = hidden ? "hidden" : "visible";
  if (hidden) return;
  panel.style.transform = `translate3d(${slide.value}px, 0, 0)`;
  panel.style.opacity = String(Math.min(Math.max(fade.value, 0), 1));

  for (const s of sections) {
    s.body.style.height = `${Math.max(0, s.height.value)}px`;
    s.chev.style.transform = `rotate(${s.turn.value * 90}deg)`;
    const e = s.enter.value; // 0 = 到位，1 = 还在右边
    s.el.style.transform = `translate3d(${e * 40}px, 0, 0)`;
    s.el.style.opacity = String(Math.min(Math.max(1 - e, 0), 1));
  }
}

// ---------- 滑出 / 收回（由 Rust 决定，页面只负责动画） ----------
let staggerTimers: number[] = [];

function applyState(st: ShelfState) {
  staggerTimers.forEach(clearTimeout);
  staggerTimers = [];
  document.body.dataset.open = String(st.open);
  slide.target = st.open ? 0 : HIDDEN_X;
  fade.target = st.open ? 1 : 0;

  if (st.open) {
    // 各分类从右往左依次跟上，像游戏菜单一样有层次
    sections.forEach((s, i) => {
      s.enter.value = 1;
      s.enter.velocity = 0;
      s.enter.target = 1;
      staggerTimers.push(
        window.setTimeout(() => {
          s.enter.target = 0;
          animator.kick();
        }, 40 + i * STAGGER_MS),
      );
    });
    // 快捷键打开的：直接可以打字搜索（等窗口真正拿到焦点后再放光标）
    if (st.pinned) staggerTimers.push(window.setTimeout(() => search.focus(), 60));
  } else {
    search.blur();
  }
  animator.kick();
}

listen<ShelfState>("shelf-state", (e) => applyState(e.payload));

// Esc 收回
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") invoke("shelf_cmd", { action: "hide" }).catch(() => {});
});

// ---------- 告诉 Rust 哪块区域算"在架子上"：面板 + 右边的空隙 ----------
function sendHitRect() {
  const w = window.innerWidth;
  const rect = { x: w - GAP - panel.offsetWidth, y: GAP, w: panel.offsetWidth + GAP, h: window.innerHeight - GAP * 2 };
  invoke("shelf_set_hit_rect", { rect }).catch(() => {});
}
window.addEventListener("resize", sendHitRect);
sendHitRect();

// ---------- 配置：底部提示里写上快捷键 ----------
invoke<Config>("config_get")
  .then((cfg) => {
    if (cfg.shelf_width) {
      const wasHidden = slide.target === HIDDEN_X;
      panel.style.width = `${cfg.shelf_width}px`;
      HIDDEN_X = cfg.shelf_width + GAP + 34;
      if (wasHidden) slide.value = slide.target = HIDDEN_X;
      sendHitRect();
      render();
    }
    const key = cfg.shelf_hotkey?.trim();
    foot.innerHTML = key
      ? `鼠标推到右边缘停一下，或按 <kbd>${key.replace(/[<>&]/g, "")}</kbd>`
      : "鼠标推到右边缘停一下就会滑出来";
  })
  .catch(() => {});

// 预热：启动后在看不见的状态下把面板完整画一次（中文字形、玻璃阴影都先准备好），
// 第一次滑出时就不用临时去画，避免卡一下
async function warmUp() {
  await document.fonts?.ready;
  panel.style.visibility = "visible";
  panel.style.transform = "translate3d(0, 0, 0)";
  panel.style.opacity = "0.002";
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  if (slide.target === HIDDEN_X) render();
}

render();
warmUp();
