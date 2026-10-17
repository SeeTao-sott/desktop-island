// 裂缝射击：准星和设置面板。
// 准星照 Valorant 的"内侧线"画：四条短线围着中心，可调颜色、长度、粗细、间隙、描边、中心点。
// 设置存在这个窗口自己的 localStorage 里（只在本机，下次打开还在）。

export interface AimSettings {
  /** Valorant 灵敏度：每个鼠标移动单位转 0.07 × 灵敏度 度 */
  sens: number;
  color: string;
  /** 每条线的长度、粗细、离中心的间隙（像素） */
  length: number;
  thick: number;
  gap: number;
  outline: boolean;
  dot: boolean;
}

export const DEFAULTS: AimSettings = { sens: 0.4, color: "#00ffb4", length: 6, thick: 2, gap: 3, outline: true, dot: false };
const KEY = "rift-aim";

export function loadSettings(): AimSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: AimSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 存不了就算了，这次照样能用
  }
}

/** 按设置重画准星（el 固定在屏幕正中） */
export function drawCrosshair(el: HTMLElement, s: AimSettings) {
  el.replaceChildren();
  const shadow = s.outline ? "0 0 0 1px rgba(0, 0, 0, 0.6)" : "none";
  const bar = (x: number, y: number, w: number, h: number) => {
    const d = document.createElement("i");
    d.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:${s.color};box-shadow:${shadow}`;
    el.appendChild(d);
  };
  const t = s.thick;
  const half = t / 2;
  // 上下左右四条，从间隙往外伸 length
  bar(-half, -s.gap - s.length, t, s.length);
  bar(-half, s.gap, t, s.length);
  bar(-s.gap - s.length, -half, s.length, t);
  bar(s.gap, -half, s.length, t);
  if (s.dot) bar(-half, -half, t, t);
}

/** 设置面板：改了就立刻生效并保存 */
export function buildSettings(panel: HTMLElement, s: AimSettings, onChange: (s: AimSettings) => void) {
  panel.replaceChildren();
  const row = (label: string, input: HTMLElement, note?: string) => {
    const r = document.createElement("label");
    r.className = "rf-row";
    const name = document.createElement("span");
    name.textContent = label;
    r.append(name, input);
    if (note) {
      const n = document.createElement("small");
      n.textContent = note;
      r.appendChild(n);
    }
    panel.appendChild(r);
  };
  const num = (key: "sens" | "length" | "thick" | "gap", min: number, max: number, step: number) => {
    const i = document.createElement("input");
    i.type = "number";
    i.min = String(min);
    i.max = String(max);
    i.step = String(step);
    i.value = String(s[key]);
    i.addEventListener("input", () => {
      const v = Number(i.value);
      if (!Number.isFinite(v)) return;
      s[key] = Math.min(max, Math.max(min, v));
      onChange(s);
    });
    return i;
  };
  const check = (key: "outline" | "dot") => {
    const i = document.createElement("input");
    i.type = "checkbox";
    i.checked = s[key];
    i.addEventListener("change", () => {
      s[key] = i.checked;
      onChange(s);
    });
    return i;
  };
  const color = document.createElement("input");
  color.type = "color";
  color.value = s.color;
  color.addEventListener("input", () => {
    s.color = color.value;
    onChange(s);
  });
  row("灵敏度（Valorant）", num("sens", 0.01, 10, 0.001), "和 Valorant 里填一样的数，转动角度相同");
  row("准星颜色", color);
  row("线长", num("length", 0, 20, 1));
  row("粗细", num("thick", 1, 10, 1));
  row("间隙", num("gap", 0, 20, 1));
  row("描边", check("outline"));
  row("中心点", check("dot"));
}
