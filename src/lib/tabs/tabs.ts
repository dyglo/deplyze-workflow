import { CHART_LAYOUTS, getLayoutById, loadLayoutId, type LayoutId } from '../chart/layouts';
import { loadWorkspaceJson, saveWorkspaceJson } from '../workspace/storage';

export interface TabQuote {
  price: number;
  changePercent: number;
}

export interface ChartPaneState {
  symbol: string;
  shortName?: string;
  interval?: string;
}

export interface WorkspaceTab {
  id: string;
  title: string;
  symbol: string;
  layoutId: LayoutId;
  panes?: Record<number, ChartPaneState>;
  activePane?: number;
  quote?: TabQuote;
}

export interface TabGroup {
  id: string;
  name: string;
  isDefault?: boolean;
  tabs: WorkspaceTab[];
  activeTabId: string;
}

export interface TabsState {
  groups: TabGroup[];
  activeGroupId: string;
  updatedAt?: number;
}

export const TABS_STORAGE_KEY = 'deplyzeworkflow-tabs';
export const TABS_WORKSPACE_KEY = 'tabs';
export const DEFAULT_GROUP_ID = 'default';
const MAX_PANE_SLOTS = 8;

export function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function extractShortSymbol(symbol: string): string {
  const clean = (symbol || '').trim();
  const idx = clean.indexOf(':');
  const short = idx >= 0 ? clean.slice(idx + 1) : clean;
  return short || 'XAUUSD';
}

export function createTab(overrides?: Partial<WorkspaceTab>): WorkspaceTab {
  const symbol = overrides?.symbol?.trim() || 'OANDA:XAUUSD';
  const title = overrides?.title?.trim() || extractShortSymbol(symbol);
  const layoutId = overrides?.layoutId ?? '1-single';
  const panes = overrides?.panes
    ? clonePanes(overrides.panes)
    : { 0: { symbol, shortName: title, interval: 'D' } };
  const activePane =
    typeof overrides?.activePane === 'number' && overrides.activePane >= 0
      ? overrides.activePane
      : 0;

  return {
    id: makeId('tab'),
    ...overrides,
    title,
    symbol,
    layoutId,
    panes,
    activePane
  };
}

export function clonePanes(
  panes: Record<number, ChartPaneState> | undefined
): Record<number, ChartPaneState> {
  const out: Record<number, ChartPaneState> = {};
  if (!panes) return out;
  for (const [k, v] of Object.entries(panes)) {
    const idx = Number(k);
    if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_PANE_SLOTS || !v) continue;
    if (typeof v.symbol !== 'string' || !v.symbol.trim()) continue;
    out[idx] = {
      symbol: v.symbol.trim(),
      shortName:
        typeof v.shortName === 'string' && v.shortName.trim()
          ? v.shortName.trim()
          : extractShortSymbol(v.symbol),
      interval: typeof v.interval === 'string' && v.interval.trim() ? v.interval.trim() : 'D'
    };
  }
  return out;
}

export function getPaneState(
  tab: WorkspaceTab,
  paneIndex: number
): { symbol: string; shortName: string; interval: string } {
  const entry = tab.panes?.[paneIndex];
  const symbol = entry?.symbol?.trim() || tab.symbol || 'OANDA:XAUUSD';
  const shortName = entry?.shortName?.trim() || extractShortSymbol(symbol);
  const interval = entry?.interval?.trim() || 'D';
  return { symbol, shortName, interval };
}

export function seedTabPanes(
  tab: WorkspaceTab,
  layoutId: LayoutId = tab.layoutId
): Record<number, ChartPaneState> {
  const count = getLayoutById(layoutId).count;
  const activeIdx =
    typeof tab.activePane === 'number' && tab.activePane >= 0 ? tab.activePane : 0;
  const activeEntry = tab.panes?.[activeIdx] ?? tab.panes?.[0];
  const baseSymbol = activeEntry?.symbol?.trim() || tab.symbol || 'OANDA:XAUUSD';
  const baseShort = activeEntry?.shortName?.trim() || extractShortSymbol(baseSymbol);
  const baseInterval = activeEntry?.interval?.trim() || 'D';

  const prevCount = getLayoutById(tab.layoutId).count;
  const keepLimit = Math.min(count, prevCount);
  const existing = clonePanes(tab.panes);
  const next: Record<number, ChartPaneState> = {};

  for (let i = 0; i < count; i++) {
    if (i < keepLimit && existing[i]) {
      next[i] = existing[i];
    } else {
      next[i] = {
        symbol: baseSymbol,
        shortName: baseShort,
        interval: baseInterval
      };
    }
  }
  return next;
}

export function createDefaultTabsState(): TabsState {
  const initialTab = createTab({ layoutId: loadLayoutId() });
  return {
    activeGroupId: DEFAULT_GROUP_ID,
    groups: [
      {
        id: DEFAULT_GROUP_ID,
        name: 'Tabs',
        isDefault: true,
        tabs: [initialTab],
        activeTabId: initialTab.id
      }
    ],
    updatedAt: 0
  };
}

function isValidLayoutId(val: unknown): val is LayoutId {
  return typeof val === 'string' && CHART_LAYOUTS.some((l) => l.id === val);
}

function normalizePanes(
  raw: unknown,
  fallbackSymbol: string,
  fallbackTitle: string,
  maxPanes: number
): Record<number, ChartPaneState> {
  const out: Record<number, ChartPaneState> = {};
  if (raw && typeof raw === 'object') {
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx >= maxPanes) continue;
      if (!val || typeof val !== 'object') continue;
      const obj = val as Partial<ChartPaneState>;
      const sym = typeof obj.symbol === 'string' && obj.symbol.trim() ? obj.symbol.trim() : '';
      if (!sym) continue;
      const shortName =
        typeof obj.shortName === 'string' && obj.shortName.trim()
          ? obj.shortName.trim()
          : extractShortSymbol(sym);
      const interval =
        typeof obj.interval === 'string' && obj.interval.trim() ? obj.interval.trim() : 'D';
      out[idx] = { symbol: sym, shortName, interval };
    }
  }
  if (!out[0]) {
    out[0] = {
      symbol: fallbackSymbol,
      shortName: fallbackTitle || extractShortSymbol(fallbackSymbol),
      interval: 'D'
    };
  }
  for (let i = 1; i < maxPanes; i++) {
    if (!out[i]) {
      out[i] = { ...out[0] };
    }
  }
  return out;
}

export function normalizeTabsState(parsed: Partial<TabsState> | null | undefined): TabsState | null {
  if (!parsed || !Array.isArray(parsed.groups) || parsed.groups.length === 0) {
    return null;
  }

  const groups: TabGroup[] = parsed.groups
    .filter((g): g is TabGroup => Boolean(g && typeof g.id === 'string' && typeof g.name === 'string'))
    .map((g) => {
      const validTabs: WorkspaceTab[] = Array.isArray(g.tabs)
        ? g.tabs
            .filter((t): t is WorkspaceTab => Boolean(t && typeof t.id === 'string'))
            .map((t) => {
              const layoutId: LayoutId = isValidLayoutId(t.layoutId) ? t.layoutId : '1-single';
              const paneCount = getLayoutById(layoutId).count;
              const symbol =
                typeof t.symbol === 'string' && t.symbol.trim() ? t.symbol.trim() : 'OANDA:XAUUSD';
              const title =
                typeof t.title === 'string' && t.title.trim()
                  ? t.title.trim()
                  : extractShortSymbol(symbol);
              const panes = normalizePanes(t.panes, symbol, title, paneCount);
              const rawActivePane =
                typeof t.activePane === 'number' && Number.isInteger(t.activePane)
                  ? t.activePane
                  : 0;
              const activePane =
                rawActivePane >= 0 && rawActivePane < paneCount ? rawActivePane : 0;

              return {
                id: t.id,
                title,
                symbol,
                layoutId,
                panes,
                activePane
              };
            })
        : [];

      const tabs = validTabs.length > 0 ? validTabs : [createTab()];
      const activeTabId = tabs.some((t) => t.id === g.activeTabId) ? g.activeTabId : tabs[0].id;

      return {
        id: g.id,
        name: g.name.trim() || 'Tabs',
        isDefault: g.id === DEFAULT_GROUP_ID || Boolean(g.isDefault),
        tabs,
        activeTabId
      };
    });

  if (groups.length === 0) return null;

  const activeGroupId = groups.some((g) => g.id === parsed.activeGroupId)
    ? (parsed.activeGroupId as string)
    : groups[0].id;

  return {
    groups,
    activeGroupId,
    updatedAt: typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0
  };
}

function serializeTabsState(state: TabsState, updatedAt: number): TabsState {
  return {
    activeGroupId: state.activeGroupId,
    updatedAt,
    groups: state.groups.map((g) => ({
      id: g.id,
      name: g.name,
      isDefault: g.isDefault,
      activeTabId: g.activeTabId,
      tabs: g.tabs.map((t) => {
        const panes = seedTabPanes(t, t.layoutId);
        const count = getLayoutById(t.layoutId).count;
        const activePane =
          typeof t.activePane === 'number' && t.activePane >= 0 && t.activePane < count
            ? t.activePane
            : 0;
        return {
          id: t.id,
          title: t.title,
          symbol: t.symbol,
          layoutId: t.layoutId,
          panes,
          activePane
        };
      })
    }))
  };
}

export function loadTabsState(): TabsState {
  if (typeof localStorage === 'undefined') return createDefaultTabsState();

  try {
    const raw = localStorage.getItem(TABS_STORAGE_KEY);
    if (!raw) return createDefaultTabsState();
    const parsed = JSON.parse(raw) as Partial<TabsState>;
    return normalizeTabsState(parsed) ?? createDefaultTabsState();
  } catch {
    return createDefaultTabsState();
  }
}

export function saveTabsState(state: TabsState): void {
  const updatedAt = Date.now();
  const clean = serializeTabsState(state, updatedAt);

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(clean));
    } catch {
      // Ignore storage quota errors
    }
  }

  void saveWorkspaceJson(TABS_WORKSPACE_KEY, clean);
}

/**
 * Reconciles `localStorage` with `$APPDATA/workspace/tabs.json` on startup.
 * - If localStorage was empty or older than workspace/tabs.json (e.g. after Cloud Restore / Zip Import),
 *   returns the restored state and updates localStorage.
 * - Otherwise ensures workspace/tabs.json exists so Cloud Auto-Sync & Backups include tabs & multi-chart layouts.
 */
export async function hydrateTabsStateFromWorkspace(current: TabsState): Promise<TabsState | null> {
  const hasLocal =
    typeof localStorage !== 'undefined' && Boolean(localStorage.getItem(TABS_STORAGE_KEY));
  const diskRaw = await loadWorkspaceJson<Partial<TabsState> | null>(TABS_WORKSPACE_KEY, null);
  const disk = normalizeTabsState(diskRaw);

  if (disk) {
    const localTs = current.updatedAt ?? 0;
    const diskTs = disk.updatedAt ?? 0;
    if (!hasLocal || diskTs > localTs) {
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(disk));
        } catch {
          // ignore
        }
      }
      return disk;
    }
    return null;
  }

  // Seed workspace/tabs.json on first run so Cloud Auto-Sync protects existing tabs immediately
  const seeded = serializeTabsState(current, current.updatedAt || Date.now());
  void saveWorkspaceJson(TABS_WORKSPACE_KEY, seeded);
  return null;
}

export function getActiveGroup(state: TabsState): TabGroup {
  return state.groups.find((g) => g.id === state.activeGroupId) ?? state.groups[0];
}

export function getActiveTab(state: TabsState): WorkspaceTab {
  const group = getActiveGroup(state);
  return group.tabs.find((t) => t.id === group.activeTabId) ?? group.tabs[0];
}
