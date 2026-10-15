// 架子的右键菜单：和面板同一套玻璃样式；子菜单在原地展开，不会跑出面板
export interface MenuEntry {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  /** 有子项时点击会在下面展开 */
  sub?: MenuEntry[];
  action?: () => void;
}

const menu = document.getElementById("menu")!;
const panel = document.getElementById("panel")!;
let onClose: (() => void) | null = null;

function button(e: MenuEntry, depth: number): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "mi" + (e.danger ? " danger" : "") + (depth ? " sub" : "");
  b.disabled = !!e.disabled;
  b.textContent = e.label;
  if (e.sub) b.classList.add("has-sub");
  return b;
}

export function openMenu(clientX: number, clientY: number, entries: MenuEntry[], closed?: () => void) {
  closeMenu();
  onClose = closed ?? null;
  menu.replaceChildren();
  for (const e of entries) {
    if (e.label === "-") {
      menu.appendChild(Object.assign(document.createElement("div"), { className: "msep" }));
      continue;
    }
    const b = button(e, 0);
    menu.appendChild(b);
    if (e.sub) {
      const group = document.createElement("div");
      group.className = "mgroup";
      group.hidden = true;
      for (const s of e.sub) {
        const sb = button(s, 1);
        sb.addEventListener("click", () => {
          closeMenu();
          s.action?.();
        });
        group.appendChild(sb);
      }
      menu.appendChild(group);
      b.addEventListener("click", () => {
        group.hidden = !group.hidden;
        b.classList.toggle("open", !group.hidden);
        clamp();
      });
    } else {
      b.addEventListener("click", () => {
        closeMenu();
        e.action?.();
      });
    }
  }
  const pr = panel.getBoundingClientRect();
  menu.style.left = `${clientX - pr.left}px`;
  menu.style.top = `${clientY - pr.top}px`;
  menu.hidden = false;
  clamp();
  // 下一帧再加 open，才有弹出的过渡动画
  requestAnimationFrame(() => menu.classList.add("open"));
}

/** 保证菜单整个在面板里面 */
function clamp() {
  const pr = panel.getBoundingClientRect();
  const left = parseFloat(menu.style.left);
  const top = parseFloat(menu.style.top);
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(left, pr.width - w - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(top, pr.height - h - 8))}px`;
}

export function closeMenu() {
  if (menu.hidden) return;
  menu.classList.remove("open");
  menu.hidden = true;
  const cb = onClose;
  onClose = null;
  cb?.();
}

export const menuOpen = () => !menu.hidden;

// 点菜单外面、按 Esc、滚动列表都关掉
document.addEventListener("pointerdown", (e) => {
  if (!menu.hidden && !menu.contains(e.target as Node)) closeMenu();
});
document.getElementById("list")!.addEventListener("scroll", closeMenu);
