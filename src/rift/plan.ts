// 裂缝射击：把谱变成靶子（纯计算，不碰画面）。
//
// 时间：音符的时间就是靶子该被打中的时刻。
// 位置：红色放左半边、蓝色放右半边（列数是单数时中间那列两边共用，比如 9 列是 1–5 / 5–9），再按 lineIndex 细分；
//       lineLayer（下 0 ~ 上 2）映射到行，不超过靶子出现那一刻的 N；加一点固定随机（歌名做种子，每次一样）。
// 同一时刻最多保留 2 个靶子（优先一红一蓝）。
// 高潮：4 秒滑动窗口的音符密度（个/秒）按在全曲里的排名分成 4 档 → N = 1~4；
//       密度上升时裂缝提前 1 拍开始变大（谱是提前知道的）。

export interface Shot {
  t: number;
  x: number;
  y: number;
  c: number;
}

export interface Target {
  /** 应该被打中的时刻（秒） */
  t: number;
  /** 列 0~列数-1（左到右） */
  col: number;
  /** 行，从下往上数 0~N-1（跟着所在的行一起移动） */
  rb: number;
  /** 0 红 1 蓝 */
  color: number;
  /** 在格子里的小偏移（格子边长的比例） */
  dx: number;
  dy: number;
  /** 和另一个靶子同一时刻出现（一对）：晚打的那个多给一点时间 */
  pair: boolean;
  /** 同一时刻的一组靶子共用的编号（金色、连线、右键一起打）；-1 = 单个 */
  group: number;
}

export interface NStep {
  t: number;
  n: number;
}

/** 固定随机：同一个种子每次出来的数一样（mulberry32） */
export function rng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 同一时刻（2ms 内）的音符分成一组，每组最多留 2 个：优先一红一蓝 */
export function limitPerMoment(shots: Shot[], max = 2): Shot[] {
  const out: Shot[] = [];
  let i = 0;
  while (i < shots.length) {
    let j = i;
    while (j < shots.length && shots[j].t - shots[i].t < 0.002) j++;
    const group = shots.slice(i, j);
    const red = group.find((s) => s.c === 0);
    const blue = group.find((s) => s.c === 1);
    const pick = red && blue ? [red, blue] : group.slice(0, max);
    out.push(...pick.slice(0, max));
    i = j;
  }
  return out;
}

const WINDOW = 4;
const STEP = 0.5;
/** 比这短的一档并进前一档，免得裂缝忽大忽小 */
const MIN_RUN = 2;

/** 高潮检测：返回 N 的时间表（已经算上"提前 1 拍"） */
export function densitySchedule(shots: Shot[], bpm: number): NStep[] {
  if (shots.length === 0) return [{ t: 0, n: 1 }];
  const times = shots.map((s) => s.t);
  const first = times[0];
  const last = times[times.length - 1];
  // 每 0.5 秒取一个点，数前后各 2 秒里的音符
  const samples: { t: number; d: number }[] = [];
  let lo = 0;
  let hi = 0;
  for (let t = Math.max(0, first - 1); t <= last + 1; t += STEP) {
    while (lo < times.length && times[lo] < t - WINDOW / 2) lo++;
    while (hi < times.length && times[hi] <= t + WINDOW / 2) hi++;
    samples.push({ t, d: (hi - lo) / WINDOW });
  }
  // 按"比全曲多少比例的时间密"分 4 档；只看有音符的那一段（前奏、尾奏空白不算）。
  // 一样密的算在它们中间（中位排名）：整首差不多密的谱（mania 常见的固定连打）落在中间档，
  // 不会因为大家都一样就全部掉到第 1 档、裂缝一直只开一行
  const ds = samples.filter((s) => s.t >= first && s.t <= last).map((s) => s.d).sort((a, b) => a - b);
  const lowerBound = (v: number) => {
    let lo = 0;
    let hi = ds.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ds[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const rank = (d: number) => {
    if (!ds.length) return 0;
    const below = lowerBound(d);
    const equal = lowerBound(d + 1e-9) - below;
    return (below + equal / 2) / ds.length;
  };
  let tiers = samples.map((s) => 1 + Math.min(3, Math.floor(rank(s.d) * 4)));
  // 太短的一档并进前一档
  const minLen = Math.round(MIN_RUN / STEP);
  for (let pass = 0; pass < 2; pass++) {
    let i = 0;
    while (i < tiers.length) {
      let j = i;
      while (j < tiers.length && tiers[j] === tiers[i]) j++;
      if (j - i < minLen && i > 0) for (let k = i; k < j; k++) tiers[k] = tiers[i - 1];
      i = j;
    }
  }
  tiers = tiers.map((n) => Math.min(4, Math.max(1, n)));
  // 变大提前 1 拍，变小按原时间
  const beat = 60 / Math.max(30, bpm || 120);
  const steps: NStep[] = [{ t: -Infinity, n: tiers[0] }];
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i] === tiers[i - 1]) continue;
    const t = samples[i].t - (tiers[i] > tiers[i - 1] ? beat : 0);
    steps.push({ t, n: tiers[i] });
  }
  steps.sort((a, b) => a.t - b.t);
  return steps;
}

/** 把 1~4 档按比例压到最多 maxRows 行（比如最多 2 行：1、1、2、2） */
export function capSteps(steps: NStep[], maxRows: number): NStep[] {
  const out: NStep[] = [];
  for (const s of steps) {
    const n = Math.max(1, Math.min(maxRows, Math.round((s.n * maxRows) / 4)));
    if (out.length && out[out.length - 1].n === n) continue;
    out.push({ t: s.t, n });
  }
  return out.length ? out : [{ t: -Infinity, n: 1 }];
}

/** 某一时刻的 N */
export function nAt(steps: NStep[], t: number): number {
  let n = steps[0]?.n ?? 1;
  for (const s of steps) {
    if (s.t > t) break;
    n = s.n;
  }
  return n;
}

/** 红 / 蓝各自能用的列 [起, 止]（含两头） */
export function halfOf(color: number, cols: number): [number, number] {
  const mid = (cols - 1) / 2;
  return color === 0 ? [0, Math.floor(mid)] : [Math.ceil(mid), cols - 1];
}

/** 一格的靶子打完后还要留多久（淡出）才算空出来 */
const STAY = 0.25;

/** 把音符变成靶子；lead：靶子提前多少秒出现；cols：靶墙几列
 *  - 同一格同一时间只放一个靶子：这格的靶子还在屏幕上，就换到最近的空格（优先同一行、同一半边）
 *  - 同一时刻的两个靶子挨着放（优先同一行左右相邻），可以一枪扫过去 */
export function planTargets(shots: Shot[], steps: NStep[], seed: string, lead: number, cols: number): Target[] {
  const rand = rng(seed);
  const kept = limitPerMoment(shots);
  const out: Target[] = [];
  // 每一格最近一个靶子什么时候离开屏幕
  const freeAt = new Map<string, number>();
  const key = (c: number, r: number) => `${c},${r}`;
  const isFree = (c: number, r: number, t: number) => (freeAt.get(key(c, r)) ?? -Infinity) <= t - lead;
  const inRange = (c: number, r: number, n: number) => c >= 0 && c < cols && r >= 0 && r < n;

  /** 离想要的格子最近的空格；全满时选最早空出来的那格 */
  function nearestFree(col: number, rb: number, n: number, t: number, lo: number, hi: number) {
    const cand: { c: number; r: number; d: number }[] = [];
    for (let r = 0; r < n; r++)
      for (let c = 0; c < cols; c++) {
        const d = Math.abs(c - col) + Math.abs(r - rb) * 1.5 + (c < lo || c > hi ? 2.5 : 0);
        cand.push({ c, r, d });
      }
    cand.sort((a, b) => a.d - b.d);
    const free = cand.find((x) => isFree(x.c, x.r, t));
    if (free) return free;
    return cand.reduce((a, b) => ((freeAt.get(key(b.c, b.r)) ?? 0) < (freeAt.get(key(a.c, a.r)) ?? 0) ? b : a));
  }

  const place = (s: Shot, c: number, r: number, pair: boolean, group: number) => {
    freeAt.set(key(c, r), s.t + STAY);
    out.push({ t: s.t, col: c, rb: r, color: s.c, dx: (rand() - 0.5) * 0.2, dy: (rand() - 0.5) * 0.2, pair, group: pair ? group : -1 });
  };

  let i = 0;
  while (i < kept.length) {
    let j = i;
    while (j < kept.length && kept[j].t - kept[i].t < 0.002) j++;
    const first = kept[i];
    const n = nAt(steps, first.t - lead);
    // 第一个：红左蓝右，lineIndex 细分列，lineLayer 映射到行，加一点固定随机
    const [lo, hi] = halfOf(first.c, cols);
    let col = lo + Math.round((first.x * (hi - lo)) / 3);
    if (rand() < 0.22) col += rand() < 0.5 ? -1 : 1;
    col = Math.min(hi, Math.max(lo, col));
    let rb = Math.round((first.y * (n - 1)) / 2);
    if (n > 1 && rand() < 0.15) rb += rand() < 0.5 ? -1 : 1;
    rb = Math.min(n - 1, Math.max(0, rb));
    const a = nearestFree(col, rb, n, first.t, lo, hi);
    const groupId = out.length;
    place(first, a.c, a.r, j - i > 1, groupId);
    // 同一时刻的第二个：紧挨着第一个（往它自己那一边），先同一行，再上下、斜角
    if (j - i > 1) {
      const second = kept[i + 1];
      const dir = second.c !== first.c ? (second.c === 1 ? 1 : -1) : rand() < 0.5 ? 1 : -1;
      const around: [number, number][] = [
        [a.c + dir, a.r],
        [a.c - dir, a.r],
        [a.c, a.r + 1],
        [a.c, a.r - 1],
        [a.c + dir, a.r + 1],
        [a.c + dir, a.r - 1],
        [a.c - dir, a.r + 1],
        [a.c - dir, a.r - 1],
      ];
      const spot = around.find(([c, r]) => inRange(c, r, n) && isFree(c, r, second.t));
      if (spot) place(second, spot[0], spot[1], true, groupId);
      else {
        const [lo2, hi2] = halfOf(second.c, cols);
        const b = nearestFree(a.c + dir, a.r, n, second.t, lo2, hi2);
        place(second, b.c, b.r, true, groupId);
      }
    }
    i = j;
  }
  return out;
}
