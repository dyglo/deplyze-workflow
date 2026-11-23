export type AiModelId = 'deepseek-flash' | 'deepseek-v4-pro';
export type AiEffort = 'low' | 'medium' | 'high';
export type AiWebSearchMode = 'auto' | 'on' | 'off';

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
}

export interface AiConversation {
  id: string;
  title: string;
  symbol: string;
  fullSymbol: string;
  messages: AiMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface AiChartContext {
  symbol: string;
  fullSymbol: string;
  price?: number;
  changePercent?: number;
  timezone: string;
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
