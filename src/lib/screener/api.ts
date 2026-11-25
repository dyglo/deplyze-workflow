import { resolveMacroForSymbol, type MacroRegimeResponse } from '../insights/api';
import { getApiBaseUrl } from '../workspace/storage';
import type { EnrichedScreenerRow, ScreenerRowData, ScreenerUniverseItem } from './types';

const CACHE_TTL_MS = 12_000;
let lastKey = '';
let lastFetchedAt = 0;
let lastRows: ScreenerRowData[] = [];

export async function fetchScreenerRows(
  universe: ScreenerUniverseItem[],
  macroRegime: MacroRegimeResponse | null,
  force = false,
  signal?: AbortSignal
): Promise<{ rows: EnrichedScreenerRow[]; updatedAt: string }> {
  const symbols = universe.map((u) => u.symbol);
  const reqKey = symbols.join(',');
  const now = Date.now();

  let rawRows: ScreenerRowData[] = lastRows;
  let updatedAt = new Date(now).toISOString();

  if (force || reqKey !== lastKey || now - lastFetchedAt > CACHE_TTL_MS || lastRows.length === 0) {
    const base = getApiBaseUrl();
    const res = await fetch(`${base}/api/screener`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols, force }),
      signal
    });
    if (!res.ok) {
      throw new Error(`Screener request failed (${res.status})`);
    }
    const json = (await res.json()) as { rows?: ScreenerRowData[]; updatedAt?: string };
    rawRows = Array.isArray(json.rows) ? json.rows : [];
    updatedAt = json.updatedAt ?? updatedAt;
    lastKey = reqKey;
    lastFetchedAt = now;
    lastRows = rawRows;
  }

  const bySymbol = new Map<string, ScreenerRowData>();
  const byShort = new Map<string, ScreenerRowData>();
  for (const r of rawRows) {
    bySymbol.set(r.symbol.toUpperCase(), r);
    byShort.set(r.shortName.toUpperCase(), r);
  }

  const enriched: EnrichedScreenerRow[] = [];
  for (const u of universe) {
    const data = bySymbol.get(u.symbol.toUpperCase()) ?? byShort.get(u.shortName.toUpperCase());
    if (!data) continue;
    const macro = macroRegime ? resolveMacroForSymbol(macroRegime, u.shortName) : null;
    enriched.push({
      ...data,
      symbol: u.symbol,
      shortName: u.shortName,
      description: data.description || u.description,
      category: u.category,
      watchlistGroups: u.watchlistGroups,
      watchlistSection: u.watchlistSection,
      macroBias: macro?.bias ?? 'neutral',
      macroReason: macro?.reason ?? 'Neutral macro backdrop'
    });
  }

  return { rows: enriched, updatedAt };
}
