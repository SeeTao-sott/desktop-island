// 桌面小组件的公共约定。每个组件是 kinds/ 下的一个独立文件，默认导出一个 WidgetModule；
// 主程序自动发现它们，加新组件不用改别的文件。

/** 尺寸：小 2×2、中 4×2、大 4×4（格子数，和手机桌面组件一样） */
export type SizeKey = "small" | "medium" | "large";

export const SIZES: Record<SizeKey, { cols: number; rows: number; label: string }> = {
  small: { cols: 2, rows: 2, label: "小" },
  medium: { cols: 4, rows: 2, label: "中" },
  large: { cols: 4, rows: 4, label: "大" },
};

/** 网格：一格 76px，格间距 12px，离屏幕边 24px（逻辑像素） */
export const CELL = 76;
export const GAP = 12;
export const STEP = CELL + GAP;
export const MARGIN = 24;

export const spanPx = (n: number) => n * CELL + (n - 1) * GAP;

/** 组件自己的设置项（目前只有开关） */
export interface SettingDef {
  key: string;
  label: string;
  default: boolean;
}

export type Settings = Record<string, unknown>;

export interface WidgetInstance {
  /** 换尺寸：内容按新尺寸重新排版 */
  setSize(size: SizeKey): void;
  /** 设置改了 */
  setSettings?(settings: Settings): void;
  /** 全屏程序时暂停：停掉所有计时器，不再更新界面 */
  setPaused(paused: boolean): void;
  destroy(): void;
}

export interface WidgetModule {
  /** 唯一的类型名，存在布局文件里 */
  kind: string;
  /** 组件库里显示的名字 */
  name: string;
  sizes: SizeKey[];
  defaultSize: SizeKey;
  settings?: SettingDef[];
  create(root: HTMLElement, opts: { size: SizeKey; settings: Settings }): WidgetInstance;
}

/** 某个组件的设置值：没设过的用默认值 */
export function settingsWithDefaults(mod: WidgetModule, s: Settings): Settings {
  const out: Settings = {};
  for (const d of mod.settings ?? []) out[d.key] = typeof s[d.key] === "boolean" ? s[d.key] : d.default;
  return out;
}
