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

export interface AiWorkspacePaneSnapshot {
  index: number;
  symbol: string;
  shortName: string;
  interval: string;
}

export interface AiWorkspacePositionSnapshot {
  id: string;
  symbol: string;
  shortName: string;
  side: 'long' | 'short';
  quantity: number;
  avgFillPrice: number;
  takeProfit: number | null;
  stopLoss: number | null;
  unrealizedPnlUsd?: number;
  rMultiple?: number | null;
}

export interface AiWorkspaceSnapshot {
  layoutId?: string;
  activeTabTitle?: string;
  panes?: AiWorkspacePaneSnapshot[];
  watchlists?: Array<{ id: string; name: string; symbols: string[] }>;
  activeAlerts?: Array<{
    id: string;
    symbol: string;
    shortName: string;
    scope: 'symbol' | 'watchlist';
    summary: string;
    status: string;
  }>;
  paper?: {
    connected: boolean;
    accountName?: string;
    balance?: number;
    equity?: number;
    freeMargin?: number;
    leverage?: number;
    openPositions?: AiWorkspacePositionSnapshot[];
    workingOrdersCount?: number;
    recentWinRatePct?: number | null;
    recentTradesCount?: number;
  };
  playbookSummary?: {
    totalEntries: number;
    winRatePct: number | null;
    totalR: number | null;
    bestSetup: string | null;
    bySetup?: Array<{ setupType: string; trades: number; winRatePct: number; totalR: number }>;
  };
  uncheckedPreTradeRules?: string[];
  savedStrategies?: Array<{
    id: string;
    name: string;
    symbol: string;
    interval: string;
    verdictLabel: string;
  }>;
}

export interface AiAgentStep {
  id: string;
  tool: string;
  label: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
}

export type AiClientAction =
  | {
      id: string;
      kind: 'configure_chart_desk';
      label: string;
      layoutId?: string;
      openInNewTab?: boolean;
      tabTitle?: string;
      panes: Array<{ paneIndex?: number; symbol: string; interval?: string }>;
    }
  | {
      id: string;
      kind: 'manage_watchlist';
      label: string;
      mode: 'create_group' | 'add_symbols' | 'update_bias';
      groupName: string;
      sectionName?: string;
      items: Array<{
        symbol: string;
        bias?: 'bull' | 'bear' | 'range' | 'none';
        poiNote?: string;
      }>;
    }
  | {
      id: string;
      kind: 'create_alert';
      label: string;
      symbol: string;
      scope?: 'symbol' | 'watchlist';
      watchlistGroupName?: string;
      logic?: 'and' | 'or';
      conditions: Array<{
        symbol?: string;
        metric: 'price' | 'rsi14' | 'tech_rating' | 'change_pct' | 'range_pos';
        operator:
          | 'crossing'
          | 'crossing_up'
          | 'crossing_down'
          | 'greater_than'
          | 'less_than'
          | 'abs_gte'
          | 'is_rating';
        value?: number;
        ratingTarget?: 'strong_buy' | 'buy_or_strong' | 'neutral' | 'sell_or_strong' | 'strong_sell';
      }>;
      trigger?: 'once' | 'every';
      message?: string;
    }
  | {
      id: string;
      kind: 'update_alert';
      label: string;
      alertId: string;
      operation: 'pause' | 'resume' | 'delete' | 'update_price';
      newPrice?: number;
    }
  | {
      id: string;
      kind: 'create_note';
      label: string;
      title: string;
      body: string;
      symbol?: string;
    }
  | {
      id: string;
      kind: 'add_tasks';
      label: string;
      tasks: Array<{ title: string; symbol?: string }>;
      preTradeRules?: string[];
    }
  | {
      id: string;
      kind: 'open_panel';
      label: string;
      panel: 'list' | 'calendar' | 'tasks' | 'note' | 'alerts' | 'screener' | 'news' | 'dislocation';
    };

export interface AiExecutedActionRecord {
  id: string;
  kind: AiClientAction['kind'];
  label: string;
  detail: string;
  status: 'executed' | 'undone' | 'failed';
  canUndo: boolean;
}

export type AiApprovalCard =
  | {
      id: string;
      kind: 'stage_paper_order';
      title: string;
      rationale: string;
      symbol: string;
      shortName: string;
      side: 'buy' | 'sell';
      orderType: 'market' | 'limit' | 'stop';
      entryPrice: number;
      stopLoss: number | null;
      takeProfit: number | null;
      riskPct: number;
      riskUsd: number | null;
      suggestedQuantity: number;
      rrRatio: number | null;
      spreadNote?: string;
      warnings: string[];
      status?: 'pending' | 'staged' | 'executed' | 'dismissed';
      statusNote?: string;
    }
  | {
      id: string;
      kind: 'protect_position';
      title: string;
      rationale: string;
      positionId: string;
      symbol: string;
      shortName: string;
      side: 'long' | 'short';
      operation: 'modify_brackets' | 'close_partial' | 'close_full';
      newStopLoss?: number | null;
      newTakeProfit?: number | null;
      closeFraction?: number;
      warnings: string[];
      status?: 'pending' | 'executed' | 'dismissed';
      statusNote?: string;
    }
  | {
      id: string;
      kind: 'deploy_strategy_bot';
      title: string;
      rationale: string;
      strategyId: string;
      strategyName: string;
      symbol: string;
      interval: string;
      executionMode: 'notify' | 'auto_sim';
      maxDailyLossPct: number;
      warnings: string[];
      status?: 'pending' | 'executed' | 'dismissed';
      statusNote?: string;
    };

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
  agentSteps?: AiAgentStep[];
  executedActions?: AiExecutedActionRecord[];
  approvalCards?: AiApprovalCard[];
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
