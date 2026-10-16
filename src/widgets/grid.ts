// 编辑模式的吸附网格：方形网格（方形、圆环、科幻 HUD 主题）和六边形蜂巢网格（六边形主题）。
// 两种网格各存一份位置：来回切主题时，各自的摆法都不会乱。
//
// "通栏"尺寸：从屏幕最左边铺到最右边、一格高，只能放在第 0 列，宽度按当前屏幕宽度算。

import { MARGIN, SIZES, STEP, spanPx, type SizeKey } from "./types";

export interface Cell {
  col: number;
  row: number;
}

export interface Grid {
  id: "rect" | "hex";
  /** 某个尺寸的组件在这种网格里的外框大小 */
  box(size: SizeKey): { w: number; h: number };
  /** 放在 cell 时外框左上角的位置 */
  origin(size: SizeKey, cell: Cell): { x: number; y: number };
  /** 放在 cell 时占用哪些格子（用来判断重叠） */
  cells(size: SizeKey, cell: Cell): string[];
  /** 整个外框都在屏幕里 */
  inBounds(size: SizeKey, cell: Cell, W: number, H: number): boolean;
  /** 所有格子（找空位时遍历） */
  all(W: number, H: number): Cell[];
  /** 外框左上角在 (x, y) 时，最接近的格子 */
  nearest(size: SizeKey, x: number, y: number, W: number, H: number): Cell;
}

// ---------------- 方形网格 ----------------

/** 屏幕上一行能放几格 / 一列能放几格 */
const rectCols = (W: number) => Math.max(1, Math.floor((W - 2 * MARGIN + (STEP - spanPx(1))) / STEP));
const rectRows = (H: number) => Math.max(1, Math.floor((H - 2 * MARGIN + (STEP - spanPx(1))) / STEP));
/** 这个尺寸占几列（通栏 = 整行） */
const colsOf = (size: SizeKey) => (size === "full" ? rectCols(window.innerWidth) : SIZES[size].cols);

export const rectGrid: Grid = {
  id: "rect",
  box: (size) => ({ w: spanPx(colsOf(size)), h: spanPx(SIZES[size].rows) }),
  origin: (_size, c) => ({ x: MARGIN + c.col * STEP, y: MARGIN + c.row * STEP }),
  cells(size, c) {
    const out: string[] = [];
    for (let r = 0; r < SIZES[size].rows; r++) for (let k = 0; k < colsOf(size); k++) out.push(`${c.col + k},${c.row + r}`);
    return out;
  },
  inBounds(size, c, W, H) {
    if (size === "full" && c.col !== 0) return false;
    return c.col >= 0 && c.row >= 0 && c.col + colsOf(size) <= rectCols(W) && c.row + SIZES[size].rows <= rectRows(H);
  },
  all(W, H) {
    const out: Cell[] = [];
    for (let r = 0; r * STEP < H; r++) for (let c = 0; c * STEP < W; c++) out.push({ col: c, row: r });
    return out;
  },
  nearest: (size, x, y) => ({
    col: size === "full" ? 0 : Math.round((x - MARGIN) / STEP),
    row: Math.round((y - MARGIN) / STEP),
  }),
};

// ---------------- 六边形蜂巢网格 ----------------
//
// 平顶六边形，奇数列往下错开半格（odd-q）。一格的六边形半径 R；格子之间留 GAP 的缝。
//   小：一个六边形
//   中：同一行隔一列的两格连成一个左右拉长的六边形（中间那列被盖住的两个半格也算占用）
//   大：一个两倍大的六边形，占中心格和周围 6 格
//   通栏：和"中"一样的拉长六边形，从第 0 列一直拉到屏幕右边能放下的最后一个偶数列

export const HEX_R = 74;
const HEX_GAP = 10;
/** 格子间距用的"带缝半径" */
const L = HEX_R + HEX_GAP / Math.sqrt(3);
const SQ3 = Math.sqrt(3);
const COL_STEP = 1.5 * L;
const ROW_STEP = SQ3 * L;
const BIG_R = 2 * HEX_R + HEX_GAP * 0.5;

/** 通栏在蜂巢里跨几对列（第 0 列到第 2k 列） */
const hexPairs = (W: number) => Math.max(1, Math.floor((W - 2 * MARGIN - 2 * HEX_R) / (3 * L)));

function center(c: Cell) {
  return {
    x: MARGIN + HEX_R + c.col * COL_STEP,
    y: MARGIN + (SQ3 * HEX_R) / 2 + c.row * ROW_STEP + (c.col & 1 ? ROW_STEP / 2 : 0),
  };
}

function neighbors(c: Cell): Cell[] {
  const odd = c.col & 1;
  const d = odd
    ? [[1, 0], [1, 1], [-1, 0], [-1, 1], [0, -1], [0, 1]]
    : [[1, -1], [1, 0], [-1, -1], [-1, 0], [0, -1], [0, 1]];
  return d.map(([dc, dr]) => ({ col: c.col + dc, row: c.row + dr }));
}

/** 拉长六边形（中、通栏）从 c 开始跨 pairs 对列时占用的格子 */
function stretchedCells(c: Cell, pairs: number) {
  const key = (k: Cell) => `${k.col},${k.row}`;
  const out: string[] = [];
  for (let k = 0; k <= 2 * pairs; k++) {
    const col = c.col + k;
    if (k % 2 === 0) out.push(key({ col, row: c.row }));
    else {
      // 中间被盖住的那列：按起点的奇偶取上下两个半格
      const pair = c.col & 1 ? [c.row, c.row + 1] : [c.row - 1, c.row];
      for (const r of pair) out.push(key({ col, row: r }));
    }
  }
  return out;
}

export const hexGrid: Grid = {
  id: "hex",
  box(size) {
    if (size === "small") return { w: 2 * HEX_R, h: SQ3 * HEX_R };
    if (size === "medium") return { w: 3 * L + 2 * HEX_R, h: SQ3 * HEX_R };
    if (size === "full") return { w: 3 * L * hexPairs(window.innerWidth) + 2 * HEX_R, h: SQ3 * HEX_R };
    return { w: 2 * BIG_R, h: SQ3 * BIG_R };
  },
  origin(size, c) {
    const p = center(c);
    const b = this.box(size);
    // 小、中、通栏：以第一格的中心为准；大：以中心格为准
    if (size === "large") return { x: p.x - b.w / 2, y: p.y - b.h / 2 };
    return { x: p.x - HEX_R, y: p.y - b.h / 2 };
  },
  cells(size, c) {
    if (size === "small") return [`${c.col},${c.row}`];
    if (size === "large") return [c, ...neighbors(c)].map((k) => `${k.col},${k.row}`);
    return stretchedCells(c, size === "full" ? hexPairs(window.innerWidth) : 1);
  },
  inBounds(size, c, W, H) {
    if (c.col < 0 || c.row < 0) return false;
    if (size === "full" && c.col !== 0) return false;
    const o = this.origin(size, c);
    const b = this.box(size);
    return o.x >= MARGIN - 1 && o.y >= MARGIN - 1 && o.x + b.w <= W - MARGIN + 1 && o.y + b.h <= H - MARGIN + 1;
  },
  all(W, H) {
    const out: Cell[] = [];
    for (let c = 0; MARGIN + c * COL_STEP < W; c++) for (let r = 0; MARGIN + r * ROW_STEP < H; r++) out.push({ col: c, row: r });
    return out;
  },
  nearest(size, x, y, W, H) {
    let best: Cell = { col: 0, row: 0 };
    let bestD = Infinity;
    for (const c of this.all(W, H)) {
      if (size === "full" && c.col !== 0) continue;
      const o = this.origin(size, c);
      const d = (o.x - x) ** 2 + (o.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  },
};

export const gridOf = (id: "rect" | "hex") => (id === "hex" ? hexGrid : rectGrid);
