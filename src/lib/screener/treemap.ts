import type { HeatmapColorScheme } from './types';

export interface TreemapInput<T> {
  id: string;
  weight: number;
  data: T;
}

export interface TreemapRect<T> {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  data: T;
}

function worstAspectRatio(row: number[], sideLen: number): number {
  if (row.length === 0 || sideLen <= 0) return Infinity;
  let sum = 0;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const v of row) {
    sum += v;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  if (sum <= 0 || minV <= 0) return Infinity;
  const s2 = sum * sum;
  const l2 = sideLen * sideLen;
  return Math.max((l2 * maxV) / s2, s2 / (l2 * minV));
}

/**
 * Bruls-Huizing-van Wijk Squarified Treemap layout.
 * Produces crisp low-aspect-ratio rectangles matching TradingView's heatmap packing.
 */
export function computeSquarifiedTreemap<T>(
  items: TreemapInput<T>[],
  x: number,
  y: number,
  width: number,
  height: number
): TreemapRect<T>[] {
  if (items.length === 0 || width <= 1 || height <= 1) return [];

  const valid = items
    .map((it) => ({ ...it, weight: Math.max(0.0001, Number.isFinite(it.weight) ? it.weight : 1) }))
    .sort((a, b) => b.weight - a.weight);

  const totalWeight = valid.reduce((s, i) => s + i.weight, 0);
  const totalArea = width * height;
  const scaled = valid.map((it) => ({
    item: it,
    area: (it.weight / totalWeight) * totalArea
  }));

  const out: TreemapRect<T>[] = [];
  let rx = x;
  let ry = y;
  let rw = width;
  let rh = height;

  let idx = 0;
  while (idx < scaled.length) {
    const shortSide = Math.min(rw, rh);
    const horizontal = rw >= rh; // lay out vertical strip along left edge when wider than tall

    const row: typeof scaled = [scaled[idx]];
    const rowAreas: number[] = [scaled[idx].area];
    idx += 1;

    while (idx < scaled.length) {
      const next = scaled[idx];
      const curWorst = worstAspectRatio(rowAreas, shortSide);
      const nextWorst = worstAspectRatio([...rowAreas, next.area], shortSide);
      if (nextWorst <= curWorst) {
        row.push(next);
        rowAreas.push(next.area);
        idx += 1;
      } else {
        break;
      }
    }

    const rowSum = rowAreas.reduce((s, a) => s + a, 0);
    if (horizontal) {
      const stripW = rh > 0 ? rowSum / rh : 0;
      let cy = ry;
      for (const entry of row) {
        const h = stripW > 0 ? entry.area / stripW : 0;
        out.push({ id: entry.item.id, x: rx, y: cy, w: stripW, h, data: entry.item.data });
        cy += h;
      }
      rx += stripW;
      rw = Math.max(0, rw - stripW);
    } else {
      const stripH = rw > 0 ? rowSum / rw : 0;
      let cx = rx;
      for (const entry of row) {
        const w = stripH > 0 ? entry.area / stripH : 0;
        out.push({ id: entry.item.id, x: cx, y: ry, w, h: stripH, data: entry.item.data });
        cx += w;
      }
      ry += stripH;
      rh = Math.max(0, rh - stripH);
    }
  }

  return out;
}

// Exact TradingView 7-stop Classic Palette + Color Blind + Monochrome
export interface HeatmapBucketDef {
  index: number; // 0..6
  label: string;
  color: string;
  textColor: string;
}

const PALETTES: Record<HeatmapColorScheme, { dark: string[]; light: string[] }> = {
  classic: {
    // Exact RGB/Hex values observed on tradingview.com/heatmap/stock/
    light: ['#991F29', '#F23645', '#F77C80', '#C9C9C9', '#42BD7F', '#089950', '#056636'],
    dark: ['#991F29', '#F23645', '#C85258', '#3F3F3F', '#329A67', '#089950', '#056636']
  },
  colorblind: {
    light: ['#7C3200', '#D95F02', '#FC8D62', '#C9C9C9', '#67A9CF', '#2166AC', '#08306B'],
    dark: ['#7C3200', '#D95F02', '#C96A42', '#3F3F3F', '#4A89B0', '#2166AC', '#08306B']
  },
  monochrome: {
    light: ['#222222', '#444444', '#6E6E6E', '#BDBDBD', '#8F8F8F', '#555555', '#1A1A1A'],
    dark: ['#1C1C1C', '#303030', '#484848', '#5E5E5E', '#7A7A7A', '#9E9E9E', '#C8C8C8']
  }
};

export function getHeatmapThresholds(isWideMarket: boolean, isTechRating: boolean): number[] {
  if (isTechRating) {
    return [-0.5, -0.25, -0.1, 0, 0.1, 0.25, 0.5];
  }
  // Crypto & Stocks move more than FX/Metals/Indices
  return isWideMarket ? [-6, -3, -1, 0, 1, 3, 6] : [-2, -1, -0.35, 0, 0.35, 1, 2];
}

export function getHeatmapBuckets(
  scheme: HeatmapColorScheme,
  theme: 'dark' | 'light',
  isWideMarket: boolean,
  isTechRating: boolean
): HeatmapBucketDef[] {
  const colors = PALETTES[scheme][theme];
  const thresholds = getHeatmapThresholds(isWideMarket, isTechRating);
  const labels = isTechRating
    ? ['Str Sell', 'Sell', 'Weak', 'Neutral', 'Mild', 'Buy', 'Str Buy']
    : thresholds.map((t) => `${t > 0 ? '+' : ''}${t}%`);

  return colors.map((color, index) => ({
    index,
    label: labels[index],
    color,
    textColor:
      index === 3 && theme === 'light'
        ? '#131722'
        : scheme === 'monochrome' && theme === 'dark' && index >= 5
          ? '#0d0d0d'
          : '#ffffff'
  }));
}

export function valueToBucketIndex(
  value: number | null,
  thresholds: number[]
): number {
  if (value === null || !Number.isFinite(value)) return 3;
  // thresholds = [t0, t1, t2, 0, t4, t5, t6]
  if (value <= thresholds[0]) return 0;
  if (value <= thresholds[1]) return 1;
  if (value <= thresholds[2]) return 2;
  if (value < thresholds[4]) return 3;
  if (value < thresholds[5]) return 4;
  if (value < thresholds[6]) return 5;
  return 6;
}
