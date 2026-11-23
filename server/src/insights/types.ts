export type MacroBias = 'tailwind' | 'headwind' | 'neutral';
export type AlignmentStatus = 'aligned' | 'conflict' | 'neutral';
export type TechBiasInput = 'bull' | 'bear' | 'range' | 'none';

export interface MacroMetric {
  id: string;
  label: string;
  value: string;
  delta: string;
  direction: 'up' | 'down' | 'flat';
  asOf?: string;
}

export interface SymbolMacroSummary {
  bias: MacroBias;
  reason: string;
}

export interface MacroRegimeResponse {
  riskMode: 'risk_on' | 'risk_off' | 'mixed';
  usdRegime: 'strong' | 'soft' | 'neutral';
  yieldsRegime: 'rising' | 'falling' | 'flat';
  summary: string;
  metrics: MacroMetric[];
  symbolBias: Record<string, SymbolMacroSummary>;
  updatedAt: string;
}

export interface SymbolDriver {
  label: string;
  value: string;
  delta: string;
  impact: 'bull' | 'bear' | 'neutral';
  note: string;
}

export interface InsightSource {
  title: string;
  url: string;
  publishedDate?: string;
}

export interface SymbolBriefResponse {
  symbol: string;
  shortName: string;
  fundamentalBias: MacroBias;
  alignment: AlignmentStatus;
  hasFreshCatalyst: boolean;
  headlineSummary: string;
  drivers: SymbolDriver[];
  primaryDriver: string;
  keyRisk: string;
  invalidationCatalyst: string;
  sources: InsightSource[];
  aiSynthesized: boolean;
  updatedAt: string;
}

export interface TransmissionMove {
  symbol: string;
  direction: 'up' | 'down';
}

export interface EventPlaybookResponse {
  title: string;
  country: string;
  category: string;
  consensusContext: string;
  recentTrend?: string;
  ifHot: TransmissionMove[];
  ifCold: TransmissionMove[];
  affectedSymbols: string[];
  watchNote: string;
  aiSynthesized: boolean;
  updatedAt: string;
}

export interface EdgeAuditEntryInput {
  symbol: string;
  setupType: string;
  grade: string;
  outcome: string;
  rMultiple: number | null;
  date: string;
  title?: string;
  notes?: string;
}

export interface EdgeAuditResponse {
  trueEdge: {
    headline: string;
    detail: string;
  };
  primaryLeak: {
    headline: string;
    detail: string;
  };
  nextWeekRule: {
    rule: string;
    rationale: string;
  };
  analyzedCount: number;
  aiSynthesized: boolean;
  updatedAt: string;
}
