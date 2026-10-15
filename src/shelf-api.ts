// 架子和 Rust 之间的数据格式和调用
import { invoke } from "@tauri-apps/api/core";

export interface Item {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
  kind: "folder" | "shortcut" | "image" | "file";
}

export interface Category {
  name: string;
  builtin: boolean;
  items: Item[];
}

export interface ShelfData {
  root: string;
  categories: Category[];
  removedCount: number;
}

export interface OpResult {
  opId: number | null;
  kind: "put" | "move" | "rename" | "remove" | "undo" | "rename-category" | "remove-category" | "migrate" | "restore";
  category: string | null;
  moved: { from: string; to: string; name: string }[];
  failed: { name: string; reason: string }[];
}

export const api = {
  list: () => invoke<ShelfData>("shelf_list"),
  put: (paths: string[], category: string | null) => invoke<OpResult>("shelf_put", { paths, category }),
  move: (paths: string[], category: string) => invoke<OpResult>("shelf_move", { paths, category }),
  rename: (path: string, newName: string) => invoke<OpResult>("shelf_rename", { path, newName }),
  remove: (paths: string[]) => invoke<OpResult>("shelf_remove", { paths }),
  undo: (opId: number) => invoke<OpResult>("shelf_undo", { opId }),
  open: (path: string) => invoke<void>("shelf_open", { path }),
  reveal: (path: string) => invoke<void>("shelf_reveal", { path }),
  openRemoved: () => invoke<void>("shelf_open_removed"),
  icon: (path: string, modified: number, thumb: boolean) => invoke<string | null>("shelf_icon", { path, modified, thumb }),
  createCategory: (name: string) => invoke<string>("shelf_create_category", { name }),
  renameCategory: (old: string, name: string) => invoke<OpResult>("shelf_rename_category", { old, new: name }),
  removeCategory: (name: string) => invoke<OpResult>("shelf_remove_category", { name }),
  /** 开始把文件拖出去（Shell 拖拽），拖完会收到 shelf-dragout-done */
  dragOut: (paths: string[]) => invoke<void>("shelf_drag_out", { paths }),
  /** 有撤销提示时让架子先别收回 */
  hold: (on: boolean) => invoke("shelf_cmd", { action: on ? "hold" : "release" }).catch(() => {}),
};

/** 路径里的上一级文件夹名，比如 ...\架子\文档\a.pdf → 文档 */
export const parentName = (p: string) => p.split("\\").slice(-2, -1)[0] ?? "";

/** 快捷方式不显示 .lnk/.url，和资源管理器一样 */
export function displayName(it: Item) {
  return it.kind === "shortcut" ? it.name.replace(/\.(lnk|url)$/i, "") : it.name;
}

export function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
