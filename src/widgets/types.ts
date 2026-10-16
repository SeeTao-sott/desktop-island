// 桌面小组件的公共约定。
//
// 组件（kinds/ 下每个文件）只负责"数据和操作"：现在几点、在放什么歌、番茄钟剩多少……
// 长什么样由主题（skins/ 下每个文件）决定。两边都是自动发现的独立模块：
// 加新组件、加新主题都不用改别的文件。

/** 尺寸：小 2×2、中 4×2、大 4×4（格子数，和手机桌面组件一样） */
export type SizeKey = "small" | "medium" | "large";

export const SIZES: Record<SizeKey, { cols: number; rows: number; label: string }> = {
  small: { cols: 2, rows: 2, label: "小" },
  medium: { cols: 4, rows: 2, label: "中" },
  large: { cols: 4, rows: 4, label: "大" },
};

/** 方形网格：一格 76px，格间距 12px，离屏幕边 24px（逻辑像素） */
export const CELL = 76;
export const GAP = 12;
export const STEP = CELL + GAP;
export const MARGIN = 24;

export const spanPx = (n: number) => n * CELL + (n - 1) * GAP;

/** 组件自己的设置项：开关（default 是 true/false），或者"选一个"（给 options） */
export interface SettingDef {
  key: string;
  label: string;
  default: boolean | string;
  /** 可选项；swatch 为 true 时按钮显示成这个颜色的色块（value 是颜色） */
  options?: { value: string; label: string; swatch?: boolean }[];
}

export type Settings = Record<string, unknown>;

/** 组件的数据源：主题的界面订阅它，按钮通过 act 回到它 */
export interface Model<D> {
  /** 有新数据就回调（订阅时立刻回调一次当前值，如果已经有了） */
  subscribe(cb: (d: D) => void): void;
  /** 界面上的按钮：番茄钟 start / pause，音乐 toggle / next … */
  act?(action: string): void;
  setSettings?(settings: Settings): void;
  /** 全屏程序时暂停：停掉计时器，不再推数据 */
  setPaused(paused: boolean): void;
  destroy(): void;
}

export interface WidgetModule<D = unknown> {
  /** 唯一的类型名，存在布局文件里，也是主题里界面的名字 */
  kind: string;
  /** 组件库里显示的名字 */
  name: string;
  sizes: SizeKey[];
  defaultSize: SizeKey;
  settings?: SettingDef[];
  model(settings: Settings): Model<D>;
}

/** 某个组件的设置值：没设过的用默认值 */
export function settingsWithDefaults(mod: WidgetModule, s: Settings): Settings {
  const out: Settings = {};
  for (const d of mod.settings ?? []) {
    const v = s[d.key];
    if (d.options) out[d.key] = d.options.some((o) => o.value === v) ? v : d.default;
    else out[d.key] = typeof v === "boolean" ? v : d.default;
  }
  return out;
}
