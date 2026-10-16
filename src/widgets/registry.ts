// 自动发现 kinds/ 下的所有组件：新组件只要在那里加一个文件
import type { WidgetModule } from "./types";

const found = import.meta.glob<{ default: WidgetModule }>("./kinds/*.ts", { eager: true });

export const MODULES: WidgetModule[] = Object.values(found)
  .map((m) => m.default)
  .filter(Boolean);

export const moduleOf = (kind: string) => MODULES.find((m) => m.kind === kind);
