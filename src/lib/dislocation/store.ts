import { loadNotes, saveNotes } from '../notes/api';
import { makeNoteId, todayNairobiIso, type Note } from '../notes/types';
import {
  getApiBaseUrl,
  loadWorkspaceJson,
  makeWorkspaceId,
  saveWorkspaceJson
} from '../workspace/storage';

export type DislocationTimeframe = '15m' | '1h' | '4h';
export type SmDirection = 'bullish' | 'bearish';
export type VerdictKind =
  | 'bearish_trap'
  | 'bullish_spring'
  | 'bearish_smt'
  | 'bullish_smt'
  | 'mixed'
  | 'rich'
  | 'cheap'
  | 'weak_fit'
  | 'equilibrium';

export interface DriverContribution {
  symbol: string;
  shortName: string;
  price: number | null;
  windowChangePct: number;
  beta: number;
  correlation: number;
  weightPct: number;
  pull: 'up' | 'down' | 'flat';
  lagBars: number;
  lagCorrelation: number;
  active: boolean;
}

export interface SmtSignal {
  id: string;
  direction: SmDirection;
  levelKind:
    | 'asia_high'
    | 'asia_low'
    | 'london_high'
    | 'london_low'
    | 'pdh'
    | 'pdl'
    | 'swing_high'
    | 'swing_low';
  levelLabel: string;
  peerSymbol: string;
  peerShortName: string;
  relation: 'positive' | 'inverse';
  sweptBy: 'target' | 'peer';
  targetLevel: number;
  targetExtreme: number;
  peerLevel: number;
  peerExtreme: number;
  peerGapAtr: number;
  peerGapPct: number;
  minutesAgo: number;
  freshness: 'fresh' | 'recent';
  summary: string;
}

export interface SessionPoolWatch {
  id: string;
  label: string;
  side: 'high' | 'low';
  targetLevel: number;
  distancePct: number;
  targetSwept: boolean;
  peerShortName: string;
  peerSwept: boolean;
  smtState: 'none' | 'bullish' | 'bearish';
}

export interface LeadLagReadout {
  leaderShortName: string;
  leaderSymbol: string;
  lagBars: number;
  lagMinutes: number;
  correlation: number;
  relation: 'positive' | 'inverse';
  summary: string;
}

export interface ResidualPoint {
  ts: number;
  z: number;
  spot: number;
  fair: number;
}

export interface ScoreBreakdown {
  stretchPts: number;
  maxStretchPts: number;
  fitPts: number;
  maxFitPts: number;
  smtPts: number;
  maxSmtPts: number;
  conflictPenalty: number;
  total: number;
  explanation: string;
}

export interface DislocationPayload {
  symbol: string;
  shortName: string;
  timeframe: DislocationTimeframe;
  spotPrice: number;
  fairValuePrice: number;
  gapPoints: number;
  gapPct: number;
  zScore: number;
  rSquared: number;
  driverFitLabel: 'Strong' | 'Moderate' | 'Weak';
  atr: number;
  atrPct: number;
  windowBars: number;
  horizonBars: number;
  reversingCandle: boolean;
  verdict: VerdictKind;
  verdictLabel: string;
  verdictDetail: string;
  verdictReason: string;
  convictionScore: number;
  scoreBreakdown: ScoreBreakdown;
  drivers: DriverContribution[];
  leadLag: LeadLagReadout | null;
  smtSignals: SmtSignal[];
  sessionPools: SessionPoolWatch[];
  residualSeries: ResidualPoint[];
  updatedAt: string;
}

export interface DislocationScanRow {
  symbol: string;
  shortName: string;
  spotPrice: number;
  fairValuePrice: number;
  gapPct: number;
  zScore: number;
  rSquared: number;
  driverFitLabel: 'Strong' | 'Moderate' | 'Weak';
  atr: number;
  verdict: VerdictKind;
  verdictLabel: string;
  convictionScore: number;
  topSmtLabel: string | null;
  topSmtDirection: SmDirection | null;
  topSmtMinutesAgo: number | null;
  smtConflict: boolean;
  topDriverLabel: string | null;
}

export interface DislocationScanPayload {
  timeframe: DislocationTimeframe;
  rows: DislocationScanRow[];
  updatedAt: string;
}

export interface PinnedDislocationSignal {
  id: string;
  symbol: string;
  shortName: string;
  timeframe: DislocationTimeframe;
  direction: 'long' | 'short';
  entryPrice: number;
  fairValuePrice: number;
  zScore: number;
  rSquared: number;
  atr: number;
  spreadPct: number;
  verdictLabel: string;
  smtLabel: string | null;
  createdAt: string;
  status: 'pending' | 'hit' | 'miss' | 'flat';
  maxFavorableAtr: number;
  maxAdverseAtr: number;
  netReturnAtr: number | null;
  resolvedPrice: number | null;
  resolvedAt: string | null;
}

export interface DislocationWorkspaceState {
  timeframe: DislocationTimeframe;
  signals: PinnedDislocationSignal[];
}

export interface ScorecardStats {
  total: number;
  resolved: number;
  pending: number;
  hits: number;
  misses: number;
  flats: number;
  hitRatePct: number | null;
  ciLowPct: number | null; // 95% Wilson lower bound
  ciHighPct: number | null; // 95% Wilson upper bound
  breakEvenPct: number; // spread-adjusted break-even rate
  avgNetAtr: number | null;
  minSampleSize: number;
  verdict: 'collecting' | 'keep' | 'drop' | 'early_warning';
  statusLabel: string;
}

const STORAGE_KEY = 'dislocation_radar';
const MAX_SIGNALS = 160;
const SYMBOL_CACHE_TTL_MS = 30_000;
const SCAN_CACHE_TTL_MS = 60_000;

// Conservative estimated round-trip spread/slippage (% of price)
const ESTIMATED_SPREAD_PCT: Record<string, number> = {
  XAUUSD: 0.015,
  XAGUSD: 0.06,
  EURUSD: 0.012,
  GBPUSD: 0.015,
  USDJPY: 0.015,
  AUDUSD: 0.02,
  NZDUSD: 0.025,
  USDCAD: 0.02,
  USDCHF: 0.02,
  NAS100: 0.015,
  SPX: 0.015,
  US30: 0.015,
  USOIL: 0.05,
  UKOIL: 0.05,
  BTCUSD: 0.05,
  ETHUSD: 0.06
};

const symbolCache = new Map<string, { data: DislocationPayload; fetchedAt: number }>();
const scanCache = new Map<string, { data: DislocationScanPayload; fetchedAt: number }>();

export function estimateSpreadPct(shortName: string): number {
  const clean = (shortName || '').trim().toUpperCase();
  return ESTIMATED_SPREAD_PCT[clean] ?? 0.025;
}

export async function fetchDislocation(
  symbol: string,
  tf: DislocationTimeframe,
  opts?: { force?: boolean; signal?: AbortSignal }
): Promise<DislocationPayload> {
  const key = `${symbol.trim().toUpperCase()}|${tf}`;
  const cached = symbolCache.get(key);
  if (!opts?.force && cached && Date.now() - cached.fetchedAt < SYMBOL_CACHE_TTL_MS) {
    return cached.data;
  }

  const base = getApiBaseUrl();
  const qs = new URLSearchParams({ symbol: symbol || 'OANDA:XAUUSD', tf });
  if (opts?.force) qs.set('force', '1');

  const res = await fetch(`${base}/api/insights/dislocation?${qs.toString()}`, {
    headers: { Accept: 'application/json' },
    signal: opts?.signal
  });
  if (!res.ok) {
    throw new Error(`Intermarket Radar API returned HTTP ${res.status}`);
  }
  const data = (await res.json()) as DislocationPayload;
  symbolCache.set(key, { data, fetchedAt: Date.now() });
  return data;
}

export async function fetchDislocationScan(
  tf: DislocationTimeframe,
  opts?: { force?: boolean; signal?: AbortSignal }
): Promise<DislocationScanPayload> {
  const cached = scanCache.get(tf);
  if (!opts?.force && cached && Date.now() - cached.fetchedAt < SCAN_CACHE_TTL_MS) {
    return cached.data;
  }

  const base = getApiBaseUrl();
  const qs = new URLSearchParams({ tf });
  if (opts?.force) qs.set('force', '1');

  const res = await fetch(`${base}/api/insights/dislocation/scan?${qs.toString()}`, {
    headers: { Accept: 'application/json' },
    signal: opts?.signal
  });
  if (!res.ok) {
    throw new Error(`Intermarket Scanner API returned HTTP ${res.status}`);
  }
  const data = (await res.json()) as DislocationScanPayload;
  scanCache.set(tf, { data, fetchedAt: Date.now() });
  return data;
}

export async function loadDislocationState(): Promise<DislocationWorkspaceState> {
  const fallback: DislocationWorkspaceState = { timeframe: '1h', signals: [] };
  const loaded = await loadWorkspaceJson<Partial<DislocationWorkspaceState>>(STORAGE_KEY, fallback);
  const tf: DislocationTimeframe =
    loaded?.timeframe === '15m' || loaded?.timeframe === '4h' ? loaded.timeframe : '1h';
  const signals = Array.isArray(loaded?.signals)
    ? loaded.signals.slice(0, MAX_SIGNALS).map((s) => ({
        ...s,
        spreadPct:
          typeof s.spreadPct === 'number' && Number.isFinite(s.spreadPct)
            ? s.spreadPct
            : estimateSpreadPct(s.shortName)
      }))
    : [];
  return { timeframe: tf, signals };
}

export async function saveDislocationState(next: DislocationWorkspaceState): Promise<void> {
  await saveWorkspaceJson(STORAGE_KEY, {
    timeframe: next.timeframe,
    signals: next.signals.slice(0, MAX_SIGNALS)
  });
}

export function inferSignalDirection(payload: DislocationPayload): 'long' | 'short' {
  if (
    payload.verdict === 'bearish_trap' ||
    payload.verdict === 'bearish_smt' ||
    payload.verdict === 'rich'
  ) {
    return 'short';
  }
  if (
    payload.verdict === 'bullish_spring' ||
    payload.verdict === 'bullish_smt' ||
    payload.verdict === 'cheap'
  ) {
    return 'long';
  }
  return payload.zScore >= 0 ? 'short' : 'long';
}

export function createPinnedSignal(payload: DislocationPayload): PinnedDislocationSignal {
  const topSmt = payload.smtSignals[0] ?? null;
  const fallbackAtr = payload.spotPrice > 0 ? payload.spotPrice * 0.004 : 1;
  return {
    id: makeWorkspaceId('dis'),
    symbol: payload.symbol,
    shortName: payload.shortName,
    timeframe: payload.timeframe,
    direction: inferSignalDirection(payload),
    entryPrice: payload.spotPrice,
    fairValuePrice: payload.fairValuePrice,
    zScore: payload.zScore,
    rSquared: payload.rSquared,
    atr: payload.atr > 0 ? payload.atr : fallbackAtr,
    spreadPct: estimateSpreadPct(payload.shortName),
    verdictLabel: payload.verdictLabel,
    smtLabel: topSmt ? `${topSmt.levelLabel} vs ${topSmt.peerShortName}` : null,
    createdAt: new Date().toISOString(),
    status: 'pending',
    maxFavorableAtr: 0,
    maxAdverseAtr: 0,
    netReturnAtr: null,
    resolvedPrice: null,
    resolvedAt: null
  };
}

/** Fixed 8-bar evaluation window (unbiased, no intrabar whipsaw stop bias). */
function horizonSecondsForTf(tf: DislocationTimeframe): number {
  if (tf === '15m') return 2 * 3600; // 8 × 15m = 2h
  if (tf === '4h') return 32 * 3600; // 8 × 4h = 32h
  return 8 * 3600; // 8 × 1h = 8h
}

interface BarRow {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Resolves tracked setups on a fixed 8-bar horizon AFTER deducting estimated spread,
 * avoiding symmetric high/low whipsaw distortion while also logging max favorable/adverse excursion.
 */
export async function resolvePendingSignals(
  signals: PinnedDislocationSignal[]
): Promise<{ signals: PinnedDislocationSignal[]; updatedCount: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const pending = signals.filter((s) => s.status === 'pending');
  if (pending.length === 0) {
    return { signals, updatedCount: 0 };
  }

  const bySymbol = new Map<string, PinnedDislocationSignal[]>();
  for (const sig of pending) {
    const createdSec = Math.floor(Date.parse(sig.createdAt) / 1000);
    if (!Number.isFinite(createdSec) || nowSec - createdSec < 300) continue;
    const list = bySymbol.get(sig.symbol) ?? [];
    list.push(sig);
    bySymbol.set(sig.symbol, list);
  }

  if (bySymbol.size === 0) {
    return { signals, updatedCount: 0 };
  }

  const base = getApiBaseUrl();
  const barsBySym = new Map<string, BarRow[]>();

  await Promise.all(
    Array.from(bySymbol.entries()).map(async ([sym, list]) => {
      const earliestSec = Math.min(
        ...list.map((s) => Math.floor(Date.parse(s.createdAt) / 1000))
      );
      try {
        const url = `${base}/api/quotes/bars?symbol=${encodeURIComponent(sym)}&from=${earliestSec}`;
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) return;
        const json = (await res.json()) as { bars?: BarRow[] };
        if (Array.isArray(json.bars)) {
          barsBySym.set(sym, json.bars);
        }
      } catch {
        // non-fatal
      }
    })
  );

  let updatedCount = 0;
  const nextSignals = signals.map((sig) => {
    if (sig.status !== 'pending') return sig;
    const bars = barsBySym.get(sig.symbol);
    if (!bars || bars.length === 0) return sig;

    const createdSec = Math.floor(Date.parse(sig.createdAt) / 1000);
    const horizonSec = horizonSecondsForTf(sig.timeframe);
    const endSec = createdSec + horizonSec;
    const atr = sig.atr > 0 ? sig.atr : Math.max(sig.entryPrice * 0.004, 1e-4);
    const spreadPx = sig.entryPrice * ((sig.spreadPct ?? estimateSpreadPct(sig.shortName)) / 100);

    const postBars = bars.filter((b) => b.ts >= createdSec && b.ts <= endSec + 1800);
    if (postBars.length === 0) return sig;

    let maxFav = sig.maxFavorableAtr;
    let maxAdv = sig.maxAdverseAtr;
    for (const b of postBars) {
      const favDelta =
        (sig.direction === 'long' ? b.high - sig.entryPrice : sig.entryPrice - b.low) - spreadPx;
      const advDelta =
        (sig.direction === 'long' ? sig.entryPrice - b.low : b.high - sig.entryPrice) + spreadPx;
      maxFav = Math.max(maxFav, favDelta / atr);
      maxAdv = Math.max(maxAdv, advDelta / atr);
    }

    let status: PinnedDislocationSignal['status'] = 'pending';
    let resolvedPrice: number | null = null;
    let resolvedAt: string | null = null;
    let netReturnAtr: number | null = null;

    if (nowSec >= endSec) {
      const exitBar = postBars.find((b) => b.ts >= endSec) ?? postBars[postBars.length - 1];
      const rawNet =
        sig.direction === 'long'
          ? exitBar.close - sig.entryPrice
          : sig.entryPrice - exitBar.close;
      const netAfterSpread = (rawNet - spreadPx) / atr;
      status = netAfterSpread > 0.02 ? 'hit' : netAfterSpread < -0.02 ? 'miss' : 'flat';
      resolvedPrice = exitBar.close;
      resolvedAt = new Date(exitBar.ts * 1000).toISOString();
      netReturnAtr = Number(netAfterSpread.toFixed(2));
    }

    const favRounded = Number(Math.max(0, maxFav).toFixed(2));
    const advRounded = Number(Math.max(0, maxAdv).toFixed(2));
    if (
      status !== sig.status ||
      favRounded !== sig.maxFavorableAtr ||
      advRounded !== sig.maxAdverseAtr
    ) {
      updatedCount += 1;
      return {
        ...sig,
        status,
        maxFavorableAtr: favRounded,
        maxAdverseAtr: advRounded,
        netReturnAtr,
        resolvedPrice,
        resolvedAt
      };
    }

    return sig;
  });

  return { signals: nextSignals, updatedCount };
}

function wilsonBounds(wins: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 0 };
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return {
    lo: Math.max(0, center - half),
    hi: Math.min(1, center + half)
  };
}

/**
 * Sample-size & spread-aware keep/drop rule:
 * - Minimum 60 decided setups.
 * - Break-even adjusts upward for average round-trip spread cost relative to Avg Move.
 * - KEEP only when 95% confidence lower bound beats spread-adjusted break-even AND avg net move > +0.10.
 *   (False-positive rate for a coin-flip signal is <1% vs ~13-21% for naive >=58% / 40.)
 */
export function computeScorecardStats(signals: PinnedDislocationSignal[]): ScorecardStats {
  const minSampleSize = 60;
  let hits = 0;
  let misses = 0;
  let flats = 0;
  let pending = 0;
  let netSum = 0;
  let netCount = 0;
  let spreadDragSum = 0;
  let spreadDragCount = 0;

  for (const s of signals) {
    if (s.status === 'hit') hits += 1;
    else if (s.status === 'miss') misses += 1;
    else if (s.status === 'flat') flats += 1;
    else pending += 1;

    if (typeof s.netReturnAtr === 'number' && Number.isFinite(s.netReturnAtr)) {
      netSum += s.netReturnAtr;
      netCount += 1;
    }

    if (s.entryPrice > 0 && s.atr > 0) {
      const spPct = s.spreadPct ?? estimateSpreadPct(s.shortName);
      const spreadInAtr = (s.entryPrice * (spPct / 100)) / s.atr;
      spreadDragSum += Math.min(0.25, spreadInAtr);
      spreadDragCount += 1;
    }
  }

  const resolved = hits + misses + flats;
  const decided = hits + misses;
  const avgSpreadDrag = spreadDragCount > 0 ? spreadDragSum / spreadDragCount : 0.05;
  const breakEvenPct = Math.round((0.5 + avgSpreadDrag * 0.5) * 100);

  const hitRatePct = decided > 0 ? Math.round((hits / decided) * 100) : null;
  const bounds = decided > 0 ? wilsonBounds(hits, decided, 1.96) : null;
  const ciLowPct = bounds ? Math.round(bounds.lo * 100) : null;
  const ciHighPct = bounds ? Math.round(bounds.hi * 100) : null;
  const avgNetAtr = netCount > 0 ? Number((netSum / netCount).toFixed(2)) : null;

  let verdict: ScorecardStats['verdict'] = 'collecting';
  let statusLabel = `Need ${Math.max(0, minSampleSize - decided)} more decided setups for a reliable verdict`;

  if (decided >= minSampleSize && ciLowPct !== null && avgNetAtr !== null) {
    if (ciLowPct > breakEvenPct && avgNetAtr >= 0.1) {
      verdict = 'keep';
      statusLabel = `Confirmed edge: 95% low bound (${ciLowPct}%) clears ${breakEvenPct}% after spread`;
    } else {
      verdict = 'drop';
      statusLabel = `No proven edge after ${decided} setups — lower bound (${ciLowPct}%) below ${breakEvenPct}% break-even`;
    }
  } else if (decided >= 35 && ciHighPct !== null && ciHighPct < breakEvenPct + 3) {
    verdict = 'early_warning';
    statusLabel = `Early warning: even top of 95% range (${ciHighPct}%) is near break-even`;
  } else if (decided > 0 && ciLowPct !== null && ciHighPct !== null) {
    statusLabel = `Collecting (${decided}/${minSampleSize}) · 95% range ${ciLowPct}%–${ciHighPct}% vs ${breakEvenPct}% break-even`;
  }

  return {
    total: signals.length,
    resolved,
    pending,
    hits,
    misses,
    flats,
    hitRatePct,
    ciLowPct,
    ciHighPct,
    breakEvenPct,
    avgNetAtr,
    minSampleSize,
    verdict,
    statusLabel
  };
}

export async function saveDislocationSnapshotToNotes(payload: DislocationPayload): Promise<Note> {
  const notes = await loadNotes();
  const nowIso = new Date().toISOString();
  const fitPct = Math.round(payload.rSquared * 100);
  const lines: string[] = [
    `Intermarket Radar Snapshot (${payload.timeframe.toUpperCase()})`,
    `Verdict: ${payload.verdictLabel} (Strength ${payload.convictionScore}/100)`,
    `Live Price: ${formatRadarPrice(payload.spotPrice, payload.shortName)} | Expected Price: ${formatRadarPrice(payload.fairValuePrice, payload.shortName)}`,
    `Price Stretch: ${formatStretchPlain(payload.zScore)} (${formatSigned(payload.gapPct, 2)}%) | Driver Fit: ${payload.driverFitLabel} (${fitPct}%)`,
    '',
    payload.verdictDetail,
    `Why: ${payload.verdictReason}`
  ];

  if (payload.smtSignals.length > 0) {
    lines.push('', 'Peer Divergences (SMT):');
    for (const s of payload.smtSignals.slice(0, 4)) {
      lines.push(
        `• [${s.direction === 'bullish' ? 'Bullish' : 'Bearish'}] ${s.summary} (${formatAgeCompact(s.minutesAgo)} ago)`
      );
    }
  }

  if (payload.leadLag) {
    lines.push('', `Leading Cue: ${payload.leadLag.summary}`);
  }

  const activeDrivers = payload.drivers.filter((d) => d.active);
  if (activeDrivers.length > 0) {
    lines.push('', 'Key Drivers:');
    for (const d of activeDrivers) {
      lines.push(
        `• ${d.shortName}: ${formatSigned(d.windowChangePct, 2)}% | Weight ${d.weightPct}% | ${formatCorrPlain(d.correlation)}`
      );
    }
  }

  const note: Note = {
    id: makeNoteId(),
    title: `Intermarket Radar — ${payload.shortName} (${payload.verdictLabel})`,
    body: lines.join('\n'),
    date: todayNairobiIso(),
    symbol: payload.shortName,
    fullSymbol: payload.symbol,
    pinned: false,
    attachments: [],
    createdAt: nowIso,
    updatedAt: nowIso
  };

  await saveNotes([note, ...notes]);
  return note;
}

export function formatStretchPlain(z: number | null | undefined): string {
  if (typeof z !== 'number' || !Number.isFinite(z)) return '—';
  const abs = Math.abs(z);
  if (abs < 0.75) return 'In line';
  const dir = z > 0 ? 'high' : 'low';
  return `${abs.toFixed(1)}× ${dir}`;
}

export function formatCorrPlain(r: number): string {
  const pct = Math.round(Math.abs(r) * 100);
  if (pct < 20) return `Weak link (${pct}%)`;
  return r >= 0 ? `Same dir (${pct}%)` : `Opposite (${pct}%)`;
}

export function formatRadarPrice(price: number | null | undefined, shortName: string): string {
  if (typeof price !== 'number' || !Number.isFinite(price)) return '—';
  const s = (shortName || '').toUpperCase();
  let decimals = 2;
  if (s.endsWith('JPY')) decimals = 3;
  else if (
    s.length === 6 &&
    /^[A-Z]{6}$/.test(s) &&
    !s.startsWith('XAU') &&
    !s.startsWith('XAG') &&
    !s.startsWith('BTC') &&
    !s.startsWith('ETH')
  ) {
    decimals = 5;
  } else if (Math.abs(price) < 10) {
    decimals = 4;
  }
  return price.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

export function formatSigned(val: number | null | undefined, decimals = 2): string {
  if (typeof val !== 'number' || !Number.isFinite(val)) return '—';
  const sign = val > 0 ? '+' : '';
  return `${sign}${val.toFixed(decimals)}`;
}

export function formatAgeCompact(minutesAgo: number): string {
  if (!Number.isFinite(minutesAgo) || minutesAgo < 1) return '<1m';
  if (minutesAgo < 60) return `${Math.round(minutesAgo)}m`;
  const h = Math.floor(minutesAgo / 60);
  const m = Math.round(minutesAgo % 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
