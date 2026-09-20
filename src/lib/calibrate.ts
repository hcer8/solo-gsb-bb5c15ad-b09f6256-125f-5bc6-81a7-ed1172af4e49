/**
 * 时间轴校准：从双版本文本中自动筛选高相似锚点，剔除顺序冲突与异常偏移后，
 * 用分段线性映射把版本 B 的时间轴对齐到版本 A 的时间轴。
 *
 * 流程：
 * 1. 候选锚点：A 的每条字幕在 B 的中点时间窗口（±maxOffsetMs）内取归一化文本
 *    相似度最高且 ≥ minSim 的配对；再按 B 侧唯一（每个 B 只保留相似度最高的 A）。
 * 2. 顺序冲突：配对按 A 序号升序后，对 B 序号求最长递增子序列（LIS），不在
 *    LIS 中的配对标记为顺序冲突并剔除。
 * 3. 异常偏移：对剩余锚点的偏移（B 中点 − A 中点）做
 *    中位数 ± max(minToleranceMs, madK·MAD) 过滤，越界者标记为异常偏移并剔除。
 * 4. 分段线性映射：以启用锚点 (B 中点 → A 中点) 为控制点，相邻控制点间线性
 *    插值，段斜率钳制到 [SLOPE_MIN, SLOPE_MAX]；段边界取相邻控制点中点，段内
 *    以左控制点为基准；首段之前 / 末段之后按最近区段斜率外推。
 * 5. 应用映射时逐条保证：时间不为负、开始时间单调不减、结束时间单调不减、
 *    时长为正（≥1ms）。
 */
import type { Cue } from './srt';
import { bigramDice, normalizeText } from './similarity';

export interface CalibOptions {
  /** 候选锚点最低文本相似度 ∈ [0,1] */
  minSim: number;
  /** 候选锚点允许的最大时间偏移（毫秒，按区间中点计） */
  maxOffsetMs: number;
  /** 异常偏移判定：相对中位数的最小容许偏差（毫秒） */
  minToleranceMs: number;
  /** 异常偏移判定：MAD（中位绝对偏差）倍数 */
  madK: number;
}

export const DEFAULT_CALIB_OPTIONS: CalibOptions = {
  minSim: 0.8,
  maxOffsetMs: 120_000,
  minToleranceMs: 1_500,
  madK: 6,
};

/** 锚点被自动剔除的原因；null 表示可参与拟合。 */
export type AnchorDrop = 'order' | 'outlier' | null;

export interface Anchor {
  /** 锚点序号（按 A 侧顺序分配） */
  id: number;
  /** A 版本 cue 索引 */
  aIdx: number;
  /** B 版本 cue 索引 */
  bIdx: number;
  /** 归一化文本相似度 ∈ [0,1] */
  sim: number;
  /** A 侧区间中点（毫秒） */
  aMid: number;
  /** B 侧区间中点（毫秒，原始时间轴） */
  bMid: number;
  /** 偏移 = bMid − aMid（毫秒） */
  offset: number;
  /** 自动剔除原因；null 表示可参与拟合 */
  dropped: AnchorDrop;
  aText: string;
  bText: string;
}

/** 映射段斜率钳制范围：防止异常锚点产生极端拉伸 / 时间倒转。 */
export const SLOPE_MIN = 0.5;
export const SLOPE_MAX = 2;

const midOf = (c: Cue) => (c.start + c.end) / 2;

function lowerBound(arr: number[], v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

function upperBound(arr: number[], v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] <= v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** 严格递增的最长递增子序列，返回保留元素在 seq 中的下标（升序）。 */
function lisIndices(seq: number[]): number[] {
  const tails: number[] = [];
  const prev = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (seq[tails[m]] < seq[i]) lo = m + 1;
      else hi = m;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    if (lo === tails.length) tails.push(i);
    else tails[lo] = i;
  }
  const out: number[] = [];
  for (let i = tails[tails.length - 1]; i >= 0; i = prev[i]) out.push(i);
  return out.reverse();
}

/** 筛选候选锚点：高相似一对一配对 → LIS 剔除顺序冲突 → 中位数 ± MAD 剔除异常偏移。 */
export function findAnchors(cuesA: Cue[], cuesB: Cue[], options?: Partial<CalibOptions>): Anchor[] {
  const opts = { ...DEFAULT_CALIB_OPTIONS, ...options };
  if (cuesA.length === 0 || cuesB.length === 0) return [];

  const normA = cuesA.map((c) => normalizeText(c.text));
  const normB = cuesB.map((c) => normalizeText(c.text));
  // B 中点索引（按中点升序），用于时间窗口二分
  const order = cuesB.map((_, i) => i).sort((x, y) => midOf(cuesB[x]) - midOf(cuesB[y]));
  const bMids = order.map((i) => midOf(cuesB[i]));

  // 每个 A 在时间窗口内取相似度最高的 B
  const bestOfA: ({ j: number; sim: number } | null)[] = normA.map((na, i) => {
    if (!na) return null;
    const aMid = midOf(cuesA[i]);
    let bestJ = -1;
    let bestSim = 0;
    const lo = lowerBound(bMids, aMid - opts.maxOffsetMs);
    const hi = upperBound(bMids, aMid + opts.maxOffsetMs);
    for (let k = lo; k < hi; k++) {
      const j = order[k];
      if (!normB[j]) continue;
      const s = bigramDice(na, normB[j]);
      if (s >= opts.minSim && s > bestSim) {
        bestSim = s;
        bestJ = j;
      }
    }
    return bestJ >= 0 ? { j: bestJ, sim: bestSim } : null;
  });

  // B 侧唯一：每个 B 只保留相似度最高的 A
  const byB = new Map<number, { i: number; sim: number }>();
  bestOfA.forEach((c, i) => {
    if (!c) return;
    const cur = byB.get(c.j);
    if (!cur || c.sim > cur.sim) byB.set(c.j, { i, sim: c.sim });
  });
  const pairs = [...byB.entries()]
    .map(([j, { i, sim }]) => ({ i, j, sim }))
    .sort((x, y) => x.i - y.i);

  // LIS 剔除顺序冲突
  const keep = new Set(lisIndices(pairs.map((p) => p.j)));
  const anchors: Anchor[] = pairs.map((p, pos) => {
    const aMid = midOf(cuesA[p.i]);
    const bMid = midOf(cuesB[p.j]);
    return {
      id: pos,
      aIdx: p.i,
      bIdx: p.j,
      sim: p.sim,
      aMid,
      bMid,
      offset: bMid - aMid,
      dropped: keep.has(pos) ? null : ('order' as const),
      aText: cuesA[p.i].text,
      bText: cuesB[p.j].text,
    };
  });

  // 中位数 ± MAD 剔除异常偏移（锚点太少时不做统计过滤）
  const alive = anchors.filter((a) => a.dropped === null);
  if (alive.length >= 3) {
    const med = median(alive.map((a) => a.offset));
    const mad = median(alive.map((a) => Math.abs(a.offset - med)));
    const tol = Math.max(opts.minToleranceMs, opts.madK * mad);
    for (const a of alive) {
      if (Math.abs(a.offset - med) > tol) a.dropped = 'outlier';
    }
  }
  return anchors;
}

/**
 * 由启用锚点构建分段线性映射 f：B 原时间 → 校准后时间。
 * 控制点为 (bMid → aMid)，相邻控制点间线性插值，段斜率钳制到
 * [SLOPE_MIN, SLOPE_MAX]，段边界取相邻控制点中点；首段之前与末段之后
 * 按最近区段斜率外推。0 个锚点时恒等，1 个锚点时为恒定平移。
 */
export function buildMapper(anchors: readonly { aMid: number; bMid: number }[]): (t: number) => number {
  const pts: { x: number; y: number }[] = [];
  for (const a of anchors) {
    if (Number.isFinite(a.aMid) && Number.isFinite(a.bMid)) pts.push({ x: a.bMid, y: a.aMid });
  }
  pts.sort((p, q) => p.x - q.x);
  const uniq = pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x);
  if (uniq.length === 0) return (t) => t;
  if (uniq.length === 1) {
    const off = uniq[0].x - uniq[0].y;
    return (t) => t - off;
  }
  const n = uniq.length;
  const slopes: number[] = [];
  const bounds: number[] = [];
  for (let k = 0; k < n - 1; k++) {
    const raw = (uniq[k + 1].y - uniq[k].y) / (uniq[k + 1].x - uniq[k].x);
    slopes.push(Math.min(SLOPE_MAX, Math.max(SLOPE_MIN, raw)));
    bounds.push((uniq[k].x + uniq[k + 1].x) / 2);
  }
  return (t) => {
    let k = 0;
    while (k < bounds.length && t >= bounds[k]) k++;
    if (k > n - 2) k = n - 2;
    return uniq[k].y + slopes[k] * (t - uniq[k].x);
  };
}

/**
 * 对 B 的每条字幕应用映射，并逐条保证：时间不为负、开始时间单调不减、
 * 结束时间单调不减、时长为正（≥1ms）。文本与编号保持不变。
 */
export function applyMapper(cues: Cue[], f: (t: number) => number): Cue[] {
  const out: Cue[] = [];
  let prevStart = -Infinity;
  let prevEnd = -Infinity;
  for (const c of cues) {
    let s = Math.max(0, Math.round(f(c.start)));
    let e = Math.max(0, Math.round(f(c.end)));
    if (s < prevStart) s = prevStart;
    if (e < prevEnd) e = prevEnd;
    if (e <= s) e = s + 1;
    out.push({ ...c, start: s, end: e });
    prevStart = s;
    prevEnd = e;
  }
  return out;
}
