import { CHART_LAYOUTS, loadLayoutId, type LayoutId } from '../chart/layouts';

export interface TabQuote {
  price: number;
  changePercent: number;
}

export interface WorkspaceTab {
  id: string;
  title: string;
  symbol: string;
  layoutId: LayoutId;
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
}

export const TABS_STORAGE_KEY = 'deplyzeworkflow-tabs';
export const DEFAULT_GROUP_ID = 'default';

export function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function createTab(overrides?: Partial<WorkspaceTab>): WorkspaceTab {
  return {
    id: makeId('tab'),
    title: 'XAUUSD',
    symbol: 'OANDA:XAUUSD',
    layoutId: '1-single',
    ...overrides
  };
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
    ]
  };
}

function isValidLayoutId(val: unknown): val is LayoutId {
  return typeof val === 'string' && CHART_LAYOUTS.some((l) => l.id === val);
}

export function loadTabsState(): TabsState {
  if (typeof localStorage === 'undefined') return createDefaultTabsState();

  try {
    const raw = localStorage.getItem(TABS_STORAGE_KEY);
    if (!raw) return createDefaultTabsState();
    const parsed = JSON.parse(raw) as Partial<TabsState>;
    if (!Array.isArray(parsed.groups) || parsed.groups.length === 0) {
      return createDefaultTabsState();
    }

    const groups: TabGroup[] = parsed.groups
      .filter((g): g is TabGroup => Boolean(g && typeof g.id === 'string' && typeof g.name === 'string'))
      .map((g) => {
        const validTabs: WorkspaceTab[] = Array.isArray(g.tabs)
          ? g.tabs
              .filter((t): t is WorkspaceTab => Boolean(t && typeof t.id === 'string'))
              .map((t) => ({
                id: t.id,
                title: typeof t.title === 'string' && t.title.trim() ? t.title.trim() : 'XAUUSD',
                symbol: typeof t.symbol === 'string' && t.symbol.trim() ? t.symbol : 'OANDA:XAUUSD',
                layoutId: isValidLayoutId(t.layoutId) ? t.layoutId : '1-single'
              }))
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

    if (groups.length === 0) return createDefaultTabsState();

    const activeGroupId = groups.some((g) => g.id === parsed.activeGroupId)
      ? (parsed.activeGroupId as string)
      : groups[0].id;

    return { groups, activeGroupId };
  } catch {
    return createDefaultTabsState();
  }
}

export function saveTabsState(state: TabsState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const clean: TabsState = {
      activeGroupId: state.activeGroupId,
      groups: state.groups.map((g) => ({
        ...g,
        tabs: g.tabs.map(({ id, title, symbol, layoutId }) => ({
          id,
          title,
          symbol,
          layoutId
        }))
      }))
    };
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // Ignore storage quota errors
  }
}

export function getActiveGroup(state: TabsState): TabGroup {
  return state.groups.find((g) => g.id === state.activeGroupId) ?? state.groups[0];
}

export function getActiveTab(state: TabsState): WorkspaceTab {
  const group = getActiveGroup(state);
  return group.tabs.find((t) => t.id === group.activeTabId) ?? group.tabs[0];
}
