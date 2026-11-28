export type AiModelId = 'deepseek-flash' | 'deepseek-v4-pro';
export type AiEffort = 'low' | 'medium' | 'high';
export type AiRangeMode = 'explain' | 'events' | 'technicals' | 'custom';

export interface AiRangeSelectionContext {
  startTs: number; // Unix seconds UTC
  endTs: number; // Unix seconds UTC
  startLabel?: string;
  endLabel?: string;
  barCount?: number;
  interval?: string;
  mode?: AiRangeMode;
  calibrated?: boolean;
}

export interface AiChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiChartContext {
  symbol?: string;
  fullSymbol?: string;
  interval?: string;
  price?: number;
  changePercent?: number;
  timezone?: string;
  range?: AiRangeSelectionContext;
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
    };

export interface AiChatRequest {
  model?: AiModelId;
  effort?: AiEffort;
  messages: AiChatHistoryMessage[];
  images?: string[]; // data:image/...;base64,...
  context?: AiChartContext;
  workspace?: AiWorkspaceSnapshot;
  webSearchMode?: 'auto' | 'on' | 'off';
}

export interface AiSourceLink {
  title: string;
  url: string;
  publishedDate?: string;
}

export interface AiModelInfo {
  id: AiModelId;
  name: string;
  description: string;
  badge?: string;
  nativeVision: boolean;
}

export const AI_MODELS: AiModelInfo[] = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek V4.1 Flash',
    description: 'Fast chart vision & data-heavy analysis',
    nativeVision: true
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    description: 'Flagship reasoning for complex setups',
    badge: 'Higher usage',
    nativeVision: false
  }
];
