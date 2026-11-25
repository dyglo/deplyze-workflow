import { markdownToCleanText } from '../ai/markdown';
import { saveImageFromBlob } from '../notes/api';
import { todayNairobiIso, type Note, type NoteAttachment } from '../notes/types';
import { loadWorkspaceJson, makeWorkspaceId, saveWorkspaceJson } from '../workspace/storage';

export type PlaybookGrade = 'A+' | 'B' | 'Mistake';
export type PlaybookOutcome = 'Win' | 'Loss' | 'BE' | 'Missed';

export const DEFAULT_SETUP_TYPES: string[] = [
  'CHoCH Reversal',
  'Liquidity Sweep',
  'Break & Retest',
  'Demand/Supply Tap'
];

export interface PlaybookEntry {
  id: string;
  title: string;
  symbol: string;
  fullSymbol: string;
  date: string; // YYYY-MM-DD
  setupType: string;
  grade: PlaybookGrade;
  outcome: PlaybookOutcome;
  rMultiple: number | null;
  notes: string;
  attachments: NoteAttachment[];
  sourceNoteId?: string;
  sourcePaperTradeId?: string;
  sourceKind?: 'manual' | 'note' | 'ai' | 'paper';
  simulated?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PlaybookState {
  entries: PlaybookEntry[];
  customSetupTypes: string[];
}

export interface PlaybookEdgeSummary {
  totalLogged: number;
  resolvedCount: number;
  winRatePct: number | null;
  totalR: number | null;
  rCount: number;
  bestSetup: string | null;
}

const STORAGE_KEY = 'playbook';

let storeState: PlaybookState = { entries: [], customSetupTypes: [] };
let hydrated = false;
let hydrationPromise: Promise<PlaybookState> | null = null;
const listeners = new Set<(s: PlaybookState) => void>();

function emit() {
  for (const fn of listeners) fn(storeState);
}

function normalizeEntry(raw: Partial<PlaybookEntry>): PlaybookEntry {
  const nowIso = new Date().toISOString();
  const grade: PlaybookGrade =
    raw.grade === 'A+' || raw.grade === 'B' || raw.grade === 'Mistake' ? raw.grade : 'A+';
  const outcome: PlaybookOutcome =
    raw.outcome === 'Win' ||
    raw.outcome === 'Loss' ||
    raw.outcome === 'BE' ||
    raw.outcome === 'Missed'
      ? raw.outcome
      : 'Win';
  const rMultiple =
    typeof raw.rMultiple === 'number' && Number.isFinite(raw.rMultiple) ? raw.rMultiple : null;

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : makeWorkspaceId('pb'),
    title: typeof raw.title === 'string' ? raw.title : '',
    symbol: typeof raw.symbol === 'string' && raw.symbol ? raw.symbol : 'XAUUSD',
    fullSymbol: typeof raw.fullSymbol === 'string' && raw.fullSymbol ? raw.fullSymbol : 'OANDA:XAUUSD',
    date: typeof raw.date === 'string' && raw.date ? raw.date : todayNairobiIso(),
    setupType: typeof raw.setupType === 'string' ? raw.setupType : '',
    grade,
    outcome,
    rMultiple,
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
    sourceNoteId: typeof raw.sourceNoteId === 'string' ? raw.sourceNoteId : undefined,
    sourcePaperTradeId:
      typeof raw.sourcePaperTradeId === 'string' ? raw.sourcePaperTradeId : undefined,
    sourceKind:
      raw.sourceKind === 'note' ||
      raw.sourceKind === 'ai' ||
      raw.sourceKind === 'manual' ||
      raw.sourceKind === 'paper'
        ? raw.sourceKind
        : 'manual',
    simulated: raw.simulated === true || raw.sourceKind === 'paper',
    createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : nowIso,
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : nowIso
  };
}

export async function initPlaybookStore(): Promise<PlaybookState> {
  if (hydrated) return storeState;
  if (!hydrationPromise) {
    hydrationPromise = loadWorkspaceJson<PlaybookState>(STORAGE_KEY, {
      entries: [],
      customSetupTypes: []
    })
      .then((loaded) => {
        const diskEntries = Array.isArray(loaded?.entries)
          ? loaded.entries.map((e) => normalizeEntry(e))
          : [];
        const diskCustom = Array.isArray(loaded?.customSetupTypes)
          ? loaded.customSetupTypes.filter((t) => typeof t === 'string' && t.trim().length > 0)
          : [];

        // Merge any entries added in memory before hydration resolved
        const memIds = new Set(storeState.entries.map((e) => e.id));
        const mergedEntries = [
          ...storeState.entries,
          ...diskEntries.filter((e) => !memIds.has(e.id))
        ];
        const mergedCustom = Array.from(
          new Set([...storeState.customSetupTypes, ...diskCustom])
        );

        storeState = { entries: mergedEntries, customSetupTypes: mergedCustom };
        hydrated = true;
        emit();
        return storeState;
      })
      .catch(() => {
        hydrated = true;
        return storeState;
      });
  }
  return hydrationPromise;
}

export async function loadPlaybookState(): Promise<PlaybookState> {
  return initPlaybookStore();
}

export function getPlaybookSnapshot(): PlaybookState {
  return storeState;
}

export function subscribePlaybook(fn: (s: PlaybookState) => void): () => void {
  listeners.add(fn);
  fn(storeState);
  if (!hydrated) void initPlaybookStore();
  return () => {
    listeners.delete(fn);
  };
}

function commit(next: PlaybookState) {
  storeState = next;
  emit();
  void saveWorkspaceJson(STORAGE_KEY, storeState);
}

export function getAllSetupTypes(state: PlaybookState): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...DEFAULT_SETUP_TYPES, ...state.customSetupTypes]) {
    const clean = name.trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(clean);
    }
  }
  for (const entry of state.entries) {
    const clean = entry.setupType.trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(clean);
    }
  }
  return out;
}

export function addCustomSetupType(name: string): string {
  const clean = name.trim().slice(0, 36);
  if (!clean) return '';
  const all = getAllSetupTypes(storeState);
  const existing = all.find((t) => t.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  commit({
    ...storeState,
    customSetupTypes: [...storeState.customSetupTypes, clean]
  });
  return clean;
}

export function upsertPlaybookEntry(entry: PlaybookEntry): void {
  const normalized = normalizeEntry(entry);
  const exists = storeState.entries.some((e) => e.id === normalized.id);
  const entries = exists
    ? storeState.entries.map((e) => (e.id === normalized.id ? normalized : e))
    : [normalized, ...storeState.entries];
  commit({ ...storeState, entries });
}

export function deletePlaybookEntry(id: string): void {
  commit({
    ...storeState,
    entries: storeState.entries.filter((e) => e.id !== id)
  });
}

export function hasPlaybookEntryForNote(noteId: string): boolean {
  return storeState.entries.some((e) => e.sourceNoteId === noteId);
}

export async function saveNoteToPlaybook(note: Note): Promise<PlaybookEntry> {
  await initPlaybookStore();
  const nowIso = new Date().toISOString();
  const existing = storeState.entries.find((e) => e.sourceNoteId === note.id);
  const entry: PlaybookEntry = existing
    ? {
        ...existing,
        title: note.title.trim() || existing.title || `${note.symbol} Setup`,
        symbol: note.symbol || existing.symbol,
        fullSymbol: note.fullSymbol || existing.fullSymbol,
        notes: note.body || existing.notes,
        attachments: note.attachments.map((a) => ({ ...a })),
        updatedAt: nowIso
      }
    : {
        id: makeWorkspaceId('pb'),
        title: note.title.trim() || `${note.symbol || 'Trade'} Setup`,
        symbol: note.symbol || 'XAUUSD',
        fullSymbol: note.fullSymbol || note.symbol || 'OANDA:XAUUSD',
        date: note.date || todayNairobiIso(),
        setupType: DEFAULT_SETUP_TYPES[0],
        grade: 'A+',
        outcome: 'Win',
        rMultiple: null,
        notes: note.body,
        attachments: note.attachments.map((a) => ({ ...a })),
        sourceNoteId: note.id,
        sourceKind: 'note',
        createdAt: nowIso,
        updatedAt: nowIso
      };
  upsertPlaybookEntry(entry);
  return entry;
}

function dataUrlToBlob(dataUrl: string): Blob | null {
  try {
    const comma = dataUrl.indexOf(',');
    if (comma === -1) return null;
    const header = dataUrl.slice(0, comma);
    const base64 = dataUrl.slice(comma + 1);
    const mimeMatch = header.match(/data:([^;]+);base64/i);
    const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}

export async function saveAiAnalysisToPlaybook(params: {
  symbol: string;
  fullSymbol: string;
  prompt: string;
  analysis: string;
  chartDataUrl?: string | null;
}): Promise<PlaybookEntry> {
  await initPlaybookStore();
  const nowIso = new Date().toISOString();
  const date = todayNairobiIso();
  const entryId = makeWorkspaceId('pb');
  const attachments: NoteAttachment[] = [];

  if (params.chartDataUrl) {
    const blob = dataUrlToBlob(params.chartDataUrl);
    if (blob) {
      try {
        const attachment = await saveImageFromBlob(
          blob,
          entryId,
          date,
          `${params.symbol}-playbook.jpg`
        );
        attachments.push(attachment);
      } catch {
        // Non-fatal: still save playbook text entry
      }
    }
  }

  const cleanPrompt = params.prompt.trim().slice(0, 68);
  const title = cleanPrompt ? cleanPrompt : `${params.symbol} AI Setup`;

  const entry: PlaybookEntry = {
    id: entryId,
    title,
    symbol: params.symbol || 'XAUUSD',
    fullSymbol: params.fullSymbol || params.symbol || 'OANDA:XAUUSD',
    date,
    setupType: DEFAULT_SETUP_TYPES[0],
    grade: 'A+',
    outcome: 'Win',
    rMultiple: null,
    notes: markdownToCleanText(params.analysis),
    attachments,
    sourceKind: 'ai',
    createdAt: nowIso,
    updatedAt: nowIso
  };
  upsertPlaybookEntry(entry);
  return entry;
}

export async function savePaperTradeToPlaybook(params: {
  tradeId: string;
  symbol: string;
  fullSymbol: string;
  side: 'long' | 'short';
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  realizedPnl: number;
  realizedR: number | null;
  closeReason: string;
  closedAt: string;
  setupType?: string;
  grade?: PlaybookGrade;
  notes?: string;
}): Promise<PlaybookEntry> {
  await initPlaybookStore();
  const existing = storeState.entries.find((e) => e.sourcePaperTradeId === params.tradeId);
  if (existing) return existing;

  const nowIso = new Date().toISOString();
  const outcome: PlaybookOutcome =
    params.realizedPnl > 0.005 ? 'Win' : params.realizedPnl < -0.005 ? 'Loss' : 'BE';
  const grade: PlaybookGrade = params.grade ?? (outcome === 'Win' ? 'A+' : outcome === 'Loss' ? 'B' : 'B');
  const dirLabel = params.side === 'long' ? 'Long' : 'Short';
  const pnlSign = params.realizedPnl >= 0 ? '+' : '';
  const summaryLines = [
    `[SIMULATED — Paper Ledger]`,
    `${dirLabel} ${params.quantity} ${params.symbol} | Entry ${params.entryPrice} -> Exit ${params.exitPrice}`,
    `Realized PnL: ${pnlSign}${params.realizedPnl.toFixed(2)} USD${params.realizedR !== null ? ` (${formatRMultiple(params.realizedR)})` : ''}`,
    `Exit reason: ${params.closeReason}`
  ];
  if (params.notes?.trim()) {
    summaryLines.push('', params.notes.trim());
  }

  const entry: PlaybookEntry = {
    id: makeWorkspaceId('pb'),
    title: `${params.symbol} ${dirLabel} (Paper)`,
    symbol: params.symbol,
    fullSymbol: params.fullSymbol || params.symbol,
    date: params.closedAt.slice(0, 10) || todayNairobiIso(),
    setupType: params.setupType?.trim() || DEFAULT_SETUP_TYPES[0],
    grade,
    outcome,
    rMultiple: params.realizedR,
    notes: summaryLines.join('\n'),
    attachments: [],
    sourcePaperTradeId: params.tradeId,
    sourceKind: 'paper',
    simulated: true,
    createdAt: nowIso,
    updatedAt: nowIso
  };
  upsertPlaybookEntry(entry);
  return entry;
}

export function computePlaybookEdge(
  entries: PlaybookEntry[],
  opts?: { includeSimulated?: boolean }
): PlaybookEdgeSummary {
  const filtered = opts?.includeSimulated ? entries : entries.filter((e) => !e.simulated);
  let wins = 0;
  let losses = 0;
  let resolvedCount = 0;
  let totalR = 0;
  let rCount = 0;

  const setupStats = new Map<string, { totalR: number; wins: number; count: number }>();

  for (const e of filtered) {
    if (e.outcome === 'Win') {
      wins += 1;
      resolvedCount += 1;
    } else if (e.outcome === 'Loss') {
      losses += 1;
      resolvedCount += 1;
    } else if (e.outcome === 'BE') {
      resolvedCount += 1;
    }

    if (typeof e.rMultiple === 'number' && Number.isFinite(e.rMultiple)) {
      totalR += e.rMultiple;
      rCount += 1;
    }

    const setup = e.setupType.trim();
    if (setup) {
      const cur = setupStats.get(setup) ?? { totalR: 0, wins: 0, count: 0 };
      cur.count += 1;
      if (e.outcome === 'Win') cur.wins += 1;
      if (typeof e.rMultiple === 'number' && Number.isFinite(e.rMultiple)) {
        cur.totalR += e.rMultiple;
      }
      setupStats.set(setup, cur);
    }
  }

  const decided = wins + losses;
  const winRatePct = decided > 0 ? Math.round((wins / decided) * 100) : null;

  let bestSetup: string | null = null;
  let bestScore = -Infinity;
  let bestWins = -1;
  for (const [name, stat] of setupStats.entries()) {
    const score = stat.totalR !== 0 ? stat.totalR : stat.wins;
    if (score > bestScore || (score === bestScore && stat.wins > bestWins)) {
      bestScore = score;
      bestWins = stat.wins;
      bestSetup = name;
    }
  }

  return {
    totalLogged: filtered.length,
    resolvedCount,
    winRatePct,
    totalR: rCount > 0 ? Number(totalR.toFixed(1)) : null,
    rCount,
    bestSetup: filtered.length > 0 ? bestSetup : null
  };
}

export function formatRMultiple(r: number | null): string {
  if (typeof r !== 'number' || !Number.isFinite(r)) return '';
  const sign = r > 0 ? '+' : '';
  const formatted = Number.isInteger(r) ? `${r}` : r.toFixed(1);
  return `${sign}${formatted}R`;
}
