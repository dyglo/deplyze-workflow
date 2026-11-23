export type AiModelId = 'deepseek-flash' | 'deepseek-v4-pro';
export type AiEffort = 'low' | 'medium' | 'high';

export interface AiChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiChartContext {
  symbol?: string;
  fullSymbol?: string;
  price?: number;
  changePercent?: number;
  timezone?: string;
}

export interface AiChatRequest {
  model?: AiModelId;
  effort?: AiEffort;
  messages: AiChatHistoryMessage[];
  images?: string[]; // data:image/...;base64,...
  context?: AiChartContext;
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
