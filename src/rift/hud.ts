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
  /** 靶墙几列（4~9） */
  cols: number;
  /** 裂缝最多开到几行（1~4） */
  rows: number;
  /** 镜头离靶墙多远（1 = 默认，越大靶墙在屏幕上越小、越集中） */
  zoom: number;
  /** 靶子大小倍数 */
  size: number;
  /** 靶子提前多少秒出现 */
  lead: number;
  /** 裂缝最大时占屏幕高度的比例 */
  maxFrac: number;
  /** 水平视野（度） */
  fov: number;
}

export const DEFAULTS: AimSettings = { sens: 0.4, color: "#00ffb4", length: 6, thick: 2, gap: 3, outline: true, dot: false, cols: 6, rows: 4, zoom: 1, size: 1, lead: 1, maxFrac: 0.6, fov: 103 };
const KEY = "rift-aim";

export function loadSettings(): AimSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const s = { ...DEFAULTS, ...raw };
    s.cols = Math.min(9, Math.max(4, Math.round(Number(s.cols) || DEFAULTS.cols)));
    s.rows = Math.min(4, Math.max(1, Math.round(Number(s.rows) || DEFAULTS.rows)));
    s.zoom = Math.min(2.5, Math.max(1, Number(s.zoom) || DEFAULTS.zoom));
    s.size = Math.min(1.6, Math.max(0.5, Number(s.size) || DEFAULTS.size));
    s.lead = Math.min(2, Math.max(0.5, Number(s.lead) || DEFAULTS.lead));
    s.maxFrac = Math.min(0.8, Math.max(0.3, Number(s.maxFrac) || DEFAULTS.maxFrac));
    s.fov = Math.min(120, Math.max(70, Number(s.fov) || DEFAULTS.fov));
    return s;
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
  const num = (
    key: "sens" | "length" | "thick" | "gap" | "cols" | "rows" | "zoom" | "size" | "lead" | "maxFrac" | "fov",
    min: number,
    max: number,
    step: number,
  ) => {
    const i = document.createElement("input");
    i.type = "number";
    i.min = String(min);
    i.max = String(max);
    i.step = String(step);
    i.value = String(s[key]);
    i.addEventListener("input", () => {
      const v = Number(i.value);
      if (!Number.isFinite(v)) return;
      s[key] = Math.min(max, Math.max(min, step >= 1 ? Math.round(v) : v));
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
  row("靶墙列数", num("cols", 4, 9, 1), "4~9 列；红靶在左半边，蓝靶在右半边");
  row("最多几行", num("rows", 1, 4, 1), "1~4 行；高潮时裂缝最多开到这么多行");
  row("镜头距离", num("zoom", 1, 2.5, 0.1), "1~2.5 倍；越大靶墙越小、越集中在准星附近");
  row("靶子大小", num("size", 0.5, 1.6, 0.1), "0.5~1.6 倍");
  row("出现提前量（秒）", num("lead", 0.5, 2, 0.1), "靶子提前多久出现、外圈收多久");
  row("裂缝最大高度", num("maxFrac", 0.3, 0.8, 0.05), "占屏幕高度的比例；改了会重新打开一下");
  row("视野 FOV", num("fov", 70, 120, 1), "水平视野（度），Valorant 是 103；改了会重新打开一下");
  row("准星颜色", color);
  row("线长", num("length", 0, 20, 1));
  row("粗细", num("thick", 1, 10, 1));
  row("间隙", num("gap", 0, 20, 1));
  row("描边", check("outline"));
  row("中心点", check("dot"));
}
