export type AiModelId = 'deepseek-flash' | 'deepseek-v4-pro';
export type AiEffort = 'low' | 'medium' | 'high';
export type AiWebSearchMode = 'auto' | 'on' | 'off';
export type AiRangeMode = 'explain' | 'events' | 'technicals' | 'custom';

export interface AiRangeSelectionContext {
  startTs: number;
  endTs: number;
  startLabel: string;
  endLabel: string;
  barCount?: number;
  netChangePct?: number | null;
  interval: string;
  mode: AiRangeMode;
  calibrated: boolean;
}

export interface PendingRangeAnalysisRequest {
  id: string;
  symbol: string;
  fullSymbol: string;
  interval: string;
  prompt: string;
  range: AiRangeSelectionContext;
  chartDataUrl: string | null;
}

export interface AiModelOption {
  id: AiModelId;
  name: string;
  shortName: string;
  description: string;
  badge?: string;
}

export const AI_MODELS: AiModelOption[] = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek V4.1 Flash',
    shortName: 'DeepSeek V4.1 Flash',
    description: 'Fast chart vision & data-heavy analysis'
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    shortName: 'DeepSeek V4 Pro',
    description: 'Flagship reasoning for complex setups',
    badge: 'Higher usage'
  }
];

export const AI_EFFORTS: { id: AiEffort; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' }
];

export interface AiSourceLink {
  title: string;
  url: string;
  publishedDate?: string;
}

export interface AiStrategyMessageSummary {
  id: string;
  name: string;
  symbol: string;
  shortName: string;
  interval: string;
  verdictStatus: string;
  verdictLabel: string;
  totalTrades: number;
  winRatePct: number;
  totalPnlUsd: number;
  totalPnlPct: number;
  profitFactor: number | null;
  oosTrades: number;
  oosProfitFactor: number | null;
  oosPnlPct: number;
}

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  createdAt: string;
  hasChart: boolean;
  imageCount: number;
  model?: AiModelId;
  sources?: AiSourceLink[];
  strategyResult?: AiStrategyMessageSummary;
  rangeContext?: AiRangeSelectionContext;
}

export interface AiConversation {
  id: string;
  title: string;
  symbol: string;
  fullSymbol: string;
  messages: AiMessage[];
  rangeContext?: AiRangeSelectionContext;
  createdAt: string;
  updatedAt: string;
}

export interface AiChartContext {
  symbol: string;
  fullSymbol: string;
  interval?: string;
  price?: number;
  changePercent?: number;
  timezone: string;
  range?: AiRangeSelectionContext;
}

export interface CapturedChart {
  dataUrl: string;
  mimeType: string;
  width: number;
  height: number;
}

export interface PendingImage {
  id: string;
  dataUrl: string;
  label: string;
}
