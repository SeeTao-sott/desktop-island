// 自动发现 skins/ 下的所有主题：加新主题只要在这里放一个文件（默认导出 Skin）
import type { Skin } from "./types";

const found = import.meta.glob<{ default: Skin }>(["./*.ts", "!./types.ts", "!./models.ts", "!./registry.ts"], {
  eager: true,
});

const ORDER = ["square", "ring", "hud", "hex"];

export const SKINS: Skin[] = Object.values(found)
  .map((m) => m.default)
  .filter((s): s is Skin => !!s && typeof s.frame === "function")
  .sort((a, b) => (ORDER.indexOf(a.id) + 1 || 99) - (ORDER.indexOf(b.id) + 1 || 99));

export const skinOf = (id: string) => SKINS.find((s) => s.id === id) ?? SKINS[0];
