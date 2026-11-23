import { loadNotes, saveNotes } from '../notes/api';
import type { Note } from '../notes/types';
import {
  loadWorkspaceJson,
  makeWorkspaceId,
  saveWorkspaceJson
} from '../workspace/storage';

export interface ChecklistRule {
  id: string;
  label: string;
  checked: boolean;
}

export interface TradingTask {
  id: string;
  title: string;
  symbol?: string;
  done: boolean;
  createdAt: string;
}

export interface RiskCalcPrefs {
  accountBalance: number;
  riskPercent: number;
  entry: string;
  stopLoss: string;
  takeProfit: string;
  contractSizeOverride: string; // blank = auto-detect by symbol
}

export interface TasksState {
  rules: ChecklistRule[];
  todos: TradingTask[];
  risk: RiskCalcPrefs;
}

const STORAGE_KEY = 'tasks';

let tasksCache: TasksState | null = null;
const tasksListeners = new Set<(s: TasksState) => void>();

function emitTasks(next: TasksState) {
  tasksCache = next;
  for (const fn of tasksListeners) fn(next);
}

export function createDefaultTasksState(): TasksState {
  return {
    rules: [
      { id: 'rule-1', label: 'HTF bias aligned with trade direction', checked: false },
      { id: 'rule-2', label: 'Price tapped clean POI / supply-demand zone', checked: false },
      { id: 'rule-3', label: 'LTF confirmation closed (CHoCH / rejection)', checked: false },
      { id: 'rule-4', label: 'No high-impact red-folder news in next 30m', checked: false },
      { id: 'rule-5', label: 'Risk-to-Reward ratio is at least 1:2', checked: false },
      { id: 'rule-6', label: 'Position size verified (risk within plan)', checked: false }
    ],
    todos: [
      {
        id: 'todo-1',
        title: 'Mark weekly & daily key levels on XAUUSD and DXY',
        symbol: 'XAUUSD',
        done: false,
        createdAt: new Date().toISOString()
      },
      {
        id: 'todo-2',
        title: 'Review today’s high-impact economic calendar events',
        done: false,
        createdAt: new Date().toISOString()
      }
    ],
    risk: {
      accountBalance: 10000,
      riskPercent: 1,
      entry: '',
      stopLoss: '',
      takeProfit: '',
      contractSizeOverride: ''
    }
  };
}

export async function loadTasksState(): Promise<TasksState> {
  const def = createDefaultTasksState();
  const loaded = await loadWorkspaceJson<TasksState>(STORAGE_KEY, def);
  const normalized: TasksState =
    !loaded || !Array.isArray(loaded.rules)
      ? def
      : {
          rules: loaded.rules,
          todos: Array.isArray(loaded.todos) ? loaded.todos : def.todos,
          risk: { ...def.risk, ...(loaded.risk ?? {}) }
        };
  emitTasks(normalized);
  return normalized;
}

export async function saveTasksState(state: TasksState): Promise<void> {
  emitTasks(state);
  await saveWorkspaceJson(STORAGE_KEY, state);
}

export function subscribeTasks(fn: (s: TasksState) => void): () => void {
  tasksListeners.add(fn);
  if (tasksCache) {
    fn(tasksCache);
  } else {
    fn(createDefaultTasksState());
    void loadTasksState();
  }
  return () => {
    tasksListeners.delete(fn);
  };
}

export async function appendPreTradeRule(
  rawLabel: string
): Promise<{ added: boolean; duplicate: boolean }> {
  const label = rawLabel.trim().slice(0, 120);
  if (!label) return { added: false, duplicate: false };

  const current = tasksCache ?? (await loadTasksState());
  const exists = current.rules.some((r) => r.label.trim().toLowerCase() === label.toLowerCase());
  if (exists) return { added: false, duplicate: true };

  const next: TasksState = {
    ...current,
    rules: [
      ...current.rules,
      {
        id: makeWorkspaceId('rule'),
        label,
        checked: false
      }
    ]
  };
  await saveTasksState(next);
  return { added: true, duplicate: false };
}

export interface InstrumentSpec {
  contractSize: number; // USD value per 1.0 price move per 1.00 standard lot (approx)
  unitLabel: string;
  pipSize: number;
  pipName: string;
  isJpyQuote: boolean;
}

export function inferInstrumentSpec(symbol: string): InstrumentSpec {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.includes('XAU') || s.includes('GOLD')) {
    return { contractSize: 100, unitLabel: '100 oz / lot', pipSize: 0.1, pipName: 'pips', isJpyQuote: false };
  }
  if (s.includes('XAG') || s.includes('SILVER')) {
    return { contractSize: 5000, unitLabel: '5,000 oz / lot', pipSize: 0.01, pipName: 'pips', isJpyQuote: false };
  }
  if (s.includes('OIL') || s.includes('WTI') || s.includes('BRENT')) {
    return { contractSize: 1000, unitLabel: '1,000 bbl / lot', pipSize: 0.01, pipName: 'ticks', isJpyQuote: false };
  }
  if (s.includes('BTC')) {
    return { contractSize: 1, unitLabel: '1 BTC / lot', pipSize: 1, pipName: 'pts', isJpyQuote: false };
  }
  if (s.includes('ETH')) {
    return { contractSize: 1, unitLabel: '1 ETH / lot', pipSize: 1, pipName: 'pts', isJpyQuote: false };
  }
  if (s.includes('NAS') || s.includes('NDX') || s.includes('US30') || s.includes('SPX') || s.includes('US500') || s.includes('DXY')) {
    return { contractSize: 1, unitLabel: '$1 / pt per lot', pipSize: 1, pipName: 'pts', isJpyQuote: false };
  }
  if (s.endsWith('JPY')) {
    return { contractSize: 100000, unitLabel: '100k units / lot', pipSize: 0.01, pipName: 'pips', isJpyQuote: true };
  }
  // Standard USD-quoted FX major (EURUSD, GBPUSD, AUDUSD, NZDUSD)
  return { contractSize: 100000, unitLabel: '100k units / lot', pipSize: 0.0001, pipName: 'pips', isJpyQuote: false };
}

export interface RiskCalculation {
  valid: boolean;
  direction: 'LONG' | 'SHORT' | null;
  riskAmount: number;
  lotSize: number;
  slDistance: number;
  slPips: number;
  pipName: string;
  rrRatio: number | null;
  rewardAmount: number | null;
  specLabel: string;
}

export function calculatePositionSize(
  symbol: string,
  risk: RiskCalcPrefs
): RiskCalculation {
  const spec = inferInstrumentSpec(symbol);
  const overrideNum = Number(risk.contractSizeOverride);
  const contractSize =
    risk.contractSizeOverride.trim() !== '' && Number.isFinite(overrideNum) && overrideNum > 0
      ? overrideNum
      : spec.contractSize;

  const balance = Number(risk.accountBalance);
  const pct = Number(risk.riskPercent);
  const entry = Number(risk.entry);
  const sl = Number(risk.stopLoss);
  const tp = Number(risk.takeProfit);

  const riskAmount =
    Number.isFinite(balance) && Number.isFinite(pct) && balance > 0 && pct > 0
      ? (balance * pct) / 100
      : 0;

  if (
    riskAmount <= 0 ||
    !Number.isFinite(entry) ||
    !Number.isFinite(sl) ||
    entry <= 0 ||
    sl <= 0 ||
    entry === sl
  ) {
    return {
      valid: false,
      direction: null,
      riskAmount,
      lotSize: 0,
      slDistance: 0,
      slPips: 0,
      pipName: spec.pipName,
      rrRatio: null,
      rewardAmount: null,
      specLabel:
        risk.contractSizeOverride.trim() !== '' ? `${contractSize} custom / lot` : spec.unitLabel
    };
  }

  const direction: 'LONG' | 'SHORT' = entry > sl ? 'LONG' : 'SHORT';
  const slDistance = Math.abs(entry - sl);
  const slPips = slDistance / spec.pipSize;

  // Risk per 1.00 lot in USD
  let riskPerLotUsd = slDistance * contractSize;
  if (spec.isJpyQuote && risk.contractSizeOverride.trim() === '') {
    riskPerLotUsd = (slDistance * contractSize) / entry;
  }

  const lotSize = riskPerLotUsd > 0 ? riskAmount / riskPerLotUsd : 0;

  let rrRatio: number | null = null;
  let rewardAmount: number | null = null;
  if (Number.isFinite(tp) && tp > 0) {
    const validTp = direction === 'LONG' ? tp > entry : tp < entry;
    if (validTp) {
      rrRatio = Math.abs(tp - entry) / slDistance;
      rewardAmount = riskAmount * rrRatio;
    }
  }

  return {
    valid: true,
    direction,
    riskAmount,
    lotSize,
    slDistance,
    slPips,
    pipName: spec.pipName,
    rrRatio,
    rewardAmount,
    specLabel:
      risk.contractSizeOverride.trim() !== '' ? `${contractSize} custom / lot` : spec.unitLabel
  };
}

export async function logPreTradePlanToNotes(params: {
  symbol: string;
  fullSymbol: string;
  rules: ChecklistRule[];
  risk: RiskCalcPrefs;
  calc: RiskCalculation;
}): Promise<void> {
  const notes = await loadNotes();
  const now = new Date();
  const nowIso = now.toISOString();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`;

  const checkedCount = params.rules.filter((r) => r.checked).length;
  const lines: string[] = [
    `Pre-Trade Checklist (${checkedCount}/${params.rules.length})`,
    ...params.rules.map((r) => `${r.checked ? '✓' : '○'} ${r.label}`)
  ];

  if (params.calc.valid) {
    lines.push('');
    lines.push(`Position Plan (${params.calc.direction})`);
    lines.push(`• Entry: ${params.risk.entry} · Stop Loss: ${params.risk.stopLoss}${params.risk.takeProfit ? ` · Take Profit: ${params.risk.takeProfit}` : ''}`);
    lines.push(
      `• Lot Size: ${params.calc.lotSize.toFixed(2)} lots · Risk: $${params.calc.riskAmount.toFixed(2)} (${params.risk.riskPercent}%)${params.calc.rrRatio ? ` · R:R 1:${params.calc.rrRatio.toFixed(2)}` : ''}`
    );
  }

  const note: Note = {
    id: makeWorkspaceId('note'),
    title: `Trade Plan — ${params.symbol}${params.calc.direction ? ` (${params.calc.direction})` : ''}`,
    body: lines.join('\n'),
    date,
    symbol: params.symbol,
    fullSymbol: params.fullSymbol,
    pinned: false,
    attachments: [],
    createdAt: nowIso,
    updatedAt: nowIso
  };

  await saveNotes([note, ...notes]);
}
