// 裂缝射击：把谱变成靶子（纯计算，不碰画面）。
//
// 时间：音符的时间就是靶子该被打中的时刻。
// 位置：红色放左半边、蓝色放右半边（列数是单数时中间那列两边共用，比如 9 列是 1–5 / 5–9），再按 lineIndex 细分；
//       lineLayer（下 0 ~ 上 2）映射到行，不超过靶子出现那一刻的 N；加一点固定随机（歌名做种子，每次一样）。
// 同一时刻最多保留 2 个靶子（优先一红一蓝）。
// 高潮：4 秒滑动窗口的音符密度（个/秒）按全曲分位数分成 4 档 → N = 1~4；
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
  // 分位数只看有音符的那一段（前奏、尾奏空白不算）
  const ds = samples.filter((s) => s.t >= first && s.t <= last).map((s) => s.d).sort((a, b) => a - b);
  const q = (p: number) => ds[Math.min(ds.length - 1, Math.floor(p * ds.length))] ?? 0;
  const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)];
  let tiers = samples.map((s) => 1 + (s.d > q1 ? 1 : 0) + (s.d > q2 ? 1 : 0) + (s.d > q3 ? 1 : 0));
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

/** 把音符变成靶子；lead：靶子提前多少秒出现；cols：靶墙几列 */
export function planTargets(shots: Shot[], steps: NStep[], seed: string, lead: number, cols: number): Target[] {
  const rand = rng(seed);
  const kept = limitPerMoment(shots);
  const out: Target[] = [];
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const n = nAt(steps, s.t - lead);
    const [lo, hi] = halfOf(s.c, cols);
    // lineIndex 0~3 → 半边里从左到右
    let col = lo + Math.round((s.x * (hi - lo)) / 3);
    if (rand() < 0.22) col += rand() < 0.5 ? -1 : 1;
    col = Math.min(hi, Math.max(lo, col));
    // lineLayer 0~2（下到上）→ 0~N-1 行
    let rb = Math.round((s.y * (n - 1)) / 2);
    if (n > 1 && rand() < 0.15) rb += rand() < 0.5 ? -1 : 1;
    rb = Math.min(n - 1, Math.max(0, rb));
    // 同一时刻的另一个靶子在同一格：挪到旁边一列
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.t - s.t) < 0.002 && prev.col === col && prev.rb === rb) {
      col = col + 1 <= hi ? col + 1 : Math.max(lo, col - 1);
    }
    out.push({ t: s.t, col, rb, color: s.c, dx: (rand() - 0.5) * 0.24, dy: (rand() - 0.5) * 0.24 });
  }
  return out;
}
