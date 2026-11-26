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
  | 'rich'
  | 'cheap'
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
  peerGapPct: number;
  minutesAgo: number;
  freshness: 'fresh' | 'recent' | 'active';
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
  atr: number;
  atrPct: number;
  windowBars: number;
  verdict: VerdictKind;
  verdictLabel: string;
  verdictDetail: string;
  convictionScore: number;
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
  atr: number;
  verdict: VerdictKind;
  verdictLabel: string;
  convictionScore: number;
  topSmtLabel: string | null;
  topSmtDirection: SmDirection | null;
  topSmtMinutesAgo: number | null;
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
  verdictLabel: string;
  smtLabel: string | null;
  createdAt: string; // ISO
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
  avgNetAtr: number | null;
  targetHitRatePct: number;
  targetSampleSize: number;
  statusLabel: string;
}

const STORAGE_KEY = 'dislocation_radar';
const MAX_SIGNALS = 120;
const SYMBOL_CACHE_TTL_MS = 30_000;
const SCAN_CACHE_TTL_MS = 60_000;

const symbolCache = new Map<string, { data: DislocationPayload; fetchedAt: number }>();
const scanCache = new Map<string, { data: DislocationScanPayload; fetchedAt: number }>();

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
  const signals = Array.isArray(loaded?.signals) ? loaded.signals.slice(0, MAX_SIGNALS) : [];
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

function horizonSecondsForTf(tf: DislocationTimeframe): number {
  if (tf === '15m') return 4 * 3600; // 4h resolution horizon
  if (tf === '4h') return 24 * 3600; // 24h resolution horizon
  return 8 * 3600; // 8h resolution horizon for 1H
}

interface BarRow {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Resolves pending pinned signals against real market OHLC bars (/api/quotes/bars).
 * Checks whether +1.0 ATR favorable hit before -1.0 ATR adverse, or resolves after horizon.
 */
export async function resolvePendingSignals(
  signals: PinnedDislocationSignal[]
): Promise<{ signals: PinnedDislocationSignal[]; updatedCount: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const pending = signals.filter((s) => s.status === 'pending');
  if (pending.length === 0) {
    return { signals, updatedCount: 0 };
  }

  // Group pending signals by symbol so we make 1 bar request per symbol
  const bySymbol = new Map<string, PinnedDislocationSignal[]>();
  for (const sig of pending) {
    const createdSec = Math.floor(Date.parse(sig.createdAt) / 1000);
    if (!Number.isFinite(createdSec) || nowSec - createdSec < 300) continue; // wait at least 5m
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

    const postBars = bars.filter((b) => b.ts >= createdSec && b.ts <= endSec + 1800);
    if (postBars.length === 0) return sig;

    let maxFav = sig.maxFavorableAtr;
    let maxAdv = sig.maxAdverseAtr;
    let status: PinnedDislocationSignal['status'] = 'pending';
    let resolvedPrice: number | null = null;
    let resolvedAt: string | null = null;
    let netReturnAtr: number | null = null;

    for (const b of postBars) {
      const favDelta =
        sig.direction === 'long' ? b.high - sig.entryPrice : sig.entryPrice - b.low;
      const advDelta =
        sig.direction === 'long' ? sig.entryPrice - b.low : b.high - sig.entryPrice;

      const favAtr = Math.max(0, favDelta / atr);
      const advAtr = Math.max(0, advDelta / atr);
      if (favAtr > maxFav) maxFav = favAtr;
      if (advAtr > maxAdv) maxAdv = advAtr;

      if (advAtr >= 1.0 && favAtr < 1.0) {
        status = 'miss';
        resolvedPrice = sig.direction === 'long' ? sig.entryPrice - atr : sig.entryPrice + atr;
        resolvedAt = new Date(b.ts * 1000).toISOString();
        netReturnAtr = -1.0;
        break;
      }
      if (favAtr >= 1.0 && advAtr < 1.0) {
        status = 'hit';
        resolvedPrice = sig.direction === 'long' ? sig.entryPrice + atr : sig.entryPrice - atr;
        resolvedAt = new Date(b.ts * 1000).toISOString();
        netReturnAtr = 1.0;
        break;
      }
      if (favAtr >= 1.0 && advAtr >= 1.0) {
        // Both touched inside same bar -> conservatively mark by bar close direction
        const barNet =
          sig.direction === 'long' ? (b.close - sig.entryPrice) / atr : (sig.entryPrice - b.close) / atr;
        status = barNet >= 0 ? 'hit' : 'miss';
        resolvedPrice = b.close;
        resolvedAt = new Date(b.ts * 1000).toISOString();
        netReturnAtr = Number(barNet.toFixed(2));
        break;
      }
    }

    if (status === 'pending' && nowSec >= endSec) {
      const lastBar = postBars[postBars.length - 1];
      const finalNet =
        sig.direction === 'long'
          ? (lastBar.close - sig.entryPrice) / atr
          : (sig.entryPrice - lastBar.close) / atr;
      status = finalNet >= 0.25 ? 'hit' : finalNet <= -0.25 ? 'miss' : 'flat';
      resolvedPrice = lastBar.close;
      resolvedAt = new Date(lastBar.ts * 1000).toISOString();
      netReturnAtr = Number(finalNet.toFixed(2));
    }

    const favRounded = Number(maxFav.toFixed(2));
    const advRounded = Number(maxAdv.toFixed(2));
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

export function computeScorecardStats(signals: PinnedDislocationSignal[]): ScorecardStats {
  const targetHitRatePct = 58;
  const targetSampleSize = 40;
  let hits = 0;
  let misses = 0;
  let flats = 0;
  let pending = 0;
  let netSum = 0;
  let netCount = 0;

  for (const s of signals) {
    if (s.status === 'hit') hits += 1;
    else if (s.status === 'miss') misses += 1;
    else if (s.status === 'flat') flats += 1;
    else pending += 1;

    if (typeof s.netReturnAtr === 'number' && Number.isFinite(s.netReturnAtr)) {
      netSum += s.netReturnAtr;
      netCount += 1;
    }
  }

  const resolved = hits + misses + flats;
  const decided = hits + misses;
  const hitRatePct = decided > 0 ? Math.round((hits / decided) * 100) : null;
  const avgNetAtr = netCount > 0 ? Number((netSum / netCount).toFixed(2)) : null;

  let statusLabel = `Collecting sample (${resolved}/${targetSampleSize})`;
  if (resolved >= targetSampleSize) {
    if (hitRatePct !== null && hitRatePct >= targetHitRatePct) {
      statusLabel = `Validated edge (${hitRatePct}% ≥ ${targetHitRatePct}%)`;
    } else {
      statusLabel = `Below target (${hitRatePct ?? 0}% < ${targetHitRatePct}% — review/drop)`;
    }
  } else if (hitRatePct !== null) {
    statusLabel =
      hitRatePct >= targetHitRatePct
        ? `Early edge tracking (${hitRatePct}% on ${decided} decided)`
        : `Early sample below target (${hitRatePct}% on ${decided} decided)`;
  }

  return {
    total: signals.length,
    resolved,
    pending,
    hits,
    misses,
    flats,
    hitRatePct,
    avgNetAtr,
    targetHitRatePct,
    targetSampleSize,
    statusLabel
  };
}

export async function saveDislocationSnapshotToNotes(payload: DislocationPayload): Promise<Note> {
  const notes = await loadNotes();
  const nowIso = new Date().toISOString();
  const lines: string[] = [
    `Intermarket Radar Snapshot (${payload.timeframe.toUpperCase()})`,
    `Verdict: ${payload.verdictLabel} (${payload.convictionScore}/100)`,
    `Spot: ${formatRadarPrice(payload.spotPrice, payload.shortName)} | Implied Fair Value: ${formatRadarPrice(payload.fairValuePrice, payload.shortName)}`,
    `Dislocation: ${formatSigned(payload.zScore, 2)}σ (${formatSigned(payload.gapPct, 2)}%) | Model R²: ${payload.rSquared.toFixed(2)} | ATR(14): ${formatRadarPrice(payload.atr, payload.shortName)}`,
    '',
    payload.verdictDetail
  ];

  if (payload.smtSignals.length > 0) {
    lines.push('', 'Active SMT Divergences:');
    for (const s of payload.smtSignals.slice(0, 4)) {
      lines.push(`• [${s.direction.toUpperCase()}] ${s.summary} (${formatAgeCompact(s.minutesAgo)} ago)`);
    }
  }

  if (payload.leadLag) {
    lines.push('', `Lead-Lag: ${payload.leadLag.summary}`);
  }

  const activeDrivers = payload.drivers.filter((d) => d.active);
  if (activeDrivers.length > 0) {
    lines.push('', 'Factor Drivers:');
    for (const d of activeDrivers) {
      lines.push(
        `• ${d.shortName}: ${formatSigned(d.windowChangePct, 2)}% | Weight ${d.weightPct}% | r = ${formatSigned(d.correlation, 2)}`
      );
    }
  }

  const note: Note = {
    id: makeNoteId(),
    title: `Intermarket Radar — ${payload.shortName} (${formatSigned(payload.zScore, 2)}σ)`,
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
