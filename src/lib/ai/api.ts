import { invoke } from '@tauri-apps/api/core';
import { loadNotes, saveImageFromBlob, saveNotes } from '../notes/api';
import type { Note, NoteAttachment } from '../notes/types';
import type {
  AiChartContext,
  AiConversation,
  AiEffort,
  AiModelId,
  AiSourceLink,
  AiWebSearchMode,
  CapturedChart
} from './types';

const DEFAULT_API_BASE = 'https://deplyze-workflow-api.onrender.com';
const FALLBACK_STORAGE_KEY = 'deplyzeworkflow.ai.chats.v1';
const PREFS_STORAGE_KEY = 'deplyzeworkflow.ai.prefs.v1';

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function getApiBaseUrl(): string {
  const metaEnv = (import.meta as { env?: Record<string, string | undefined> }).env;
  const configured = metaEnv?.VITE_API_BASE_URL?.trim();
  const base = configured && configured.length > 0 ? configured : DEFAULT_API_BASE;
  return base.replace(/\/+$/, '');
}

export function makeAiId(prefix = 'ai'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID().slice(0, 12)}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface AiUserPrefs {
  model: AiModelId;
  effort: AiEffort;
  autoCapture: boolean;
  webSearchMode: AiWebSearchMode;
}

export function loadAiPrefs(): AiUserPrefs {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AiUserPrefs>;
      return {
        model: parsed.model === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash',
        effort:
          parsed.effort === 'low' || parsed.effort === 'high' ? parsed.effort : 'medium',
        autoCapture: typeof parsed.autoCapture === 'boolean' ? parsed.autoCapture : true,
        webSearchMode:
          parsed.webSearchMode === 'on' || parsed.webSearchMode === 'off'
            ? parsed.webSearchMode
            : 'auto'
      };
    }
  } catch {
    // ignore
  }
  return {
    model: 'deepseek-flash',
    effort: 'medium',
    autoCapture: true,
    webSearchMode: 'auto'
  };
}

export function saveAiPrefs(prefs: AiUserPrefs): void {
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

export async function loadAiChats(): Promise<AiConversation[]> {
  if (isTauriRuntime()) {
    try {
      const list = await invoke<AiConversation[]>('ai_chats_load');
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }
  try {
    const raw = localStorage.getItem(FALLBACK_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AiConversation[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveAiChats(chats: AiConversation[]): Promise<void> {
  // Keep latest 40 conversations max
  const trimmed = chats.slice(0, 40);
  if (isTauriRuntime()) {
    try {
      await invoke('ai_chats_save', { chats: trimmed });
      return;
    } catch {
      // fall through
    }
  }
  try {
    localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // ignore
  }
}

/**
 * Captures the currently active TradingView chart pane via native Rust Win32 WebView2 capture.
 * Returns null gracefully when running outside Tauri or if capture fails.
 */
export async function captureActiveChart(): Promise<CapturedChart | null> {
  if (!isTauriRuntime()) return null;

  const target =
    document.querySelector<HTMLElement>('.tab-viewport.active .chart-pane.active') ??
    document.querySelector<HTMLElement>('.tab-viewport.active .chart-pane') ??
    document.querySelector<HTMLElement>('.chart-slot');

  if (!target) return null;
  const rect = target.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 40) return null;

  try {
    return await invoke<CapturedChart>('capture_chart_region', {
      region: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      }
    });
  } catch {
    return null;
  }
}

export interface AiStreamRequest {
  model: AiModelId;
  effort: AiEffort;
  messages: { role: 'user' | 'assistant'; content: string }[];
  images: string[];
  context: AiChartContext;
  webSearchMode: AiWebSearchMode;
}

export interface AiStreamCallbacks {
  onStatus?: (phase: string, label: string) => void;
  onSources?: (sources: AiSourceLink[]) => void;
  onReasoning?: (delta: string) => void;
  onToken?: (delta: string) => void;
  onDone?: (meta: { model: string; usedWebSearch: boolean; usedVision: boolean }) => void;
  onError?: (message: string) => void;
}

export async function streamAiChat(
  request: AiStreamRequest,
  callbacks: AiStreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const url = `${getApiBaseUrl()}/api/ai/chat`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream'
    },
    body: JSON.stringify(request),
    signal
  });

  if (!res.ok) {
    let msg = `AI server returned HTTP ${res.status}`;
    try {
      const errJson = (await res.json()) as { error?: string };
      if (errJson.error) msg = errJson.error;
    } catch {
      // ignore
    }
    callbacks.onError?.(msg);
    return;
  }

  if (!res.body) {
    callbacks.onError?.('Empty stream response from AI server.');
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const dispatchBlock = (block: string) => {
    const lines = block.split(/\r?\n/);
    let eventName = 'message';
    const dataParts: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataParts.push(line.slice(5).trim());
      }
    }
    if (dataParts.length === 0) return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(dataParts.join('\n')) as Record<string, unknown>;
    } catch {
      return;
    }

    if (eventName === 'status') {
      callbacks.onStatus?.(String(payload.phase ?? ''), String(payload.label ?? ''));
    } else if (eventName === 'sources' && Array.isArray(payload.sources)) {
      callbacks.onSources?.(payload.sources as AiSourceLink[]);
    } else if (eventName === 'reasoning' && typeof payload.delta === 'string') {
      callbacks.onReasoning?.(payload.delta);
    } else if (eventName === 'token' && typeof payload.delta === 'string') {
      callbacks.onToken?.(payload.delta);
    } else if (eventName === 'done') {
      callbacks.onDone?.({
        model: String(payload.model ?? request.model),
        usedWebSearch: Boolean(payload.usedWebSearch),
        usedVision: Boolean(payload.usedVision)
      });
    } else if (eventName === 'error') {
      callbacks.onError?.(String(payload.message ?? 'Unknown AI error'));
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIdx = buffer.indexOf('\n\n');
    while (sepIdx !== -1) {
      const block = buffer.slice(0, sepIdx).trim();
      buffer = buffer.slice(sepIdx + 2);
      if (block) dispatchBlock(block);
      sepIdx = buffer.indexOf('\n\n');
    }
  }

  if (buffer.trim()) {
    dispatchBlock(buffer.trim());
  }
}

/**
 * Converts a File/Blob image into a resized JPEG/PNG data URL safe for fast AI upload.
 */
export function fileToDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Could not read image'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.readAsDataURL(file);
  });
}

function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9+]+);base64,(.+)$/);
  if (!match) return null;
  const mime = match[1];
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

function getTodayDateString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Saves an AI Copilot reply (plus optional captured chart screenshot) straight into Notes.
 */
export async function saveAnalysisToNotes(params: {
  symbol: string;
  fullSymbol: string;
  prompt: string;
  analysis: string;
  chartDataUrl?: string | null;
}): Promise<void> {
  const notes = await loadNotes();
  const nowIso = new Date().toISOString();
  const date = getTodayDateString();
  const noteId = makeAiId('note');
  const attachments: NoteAttachment[] = [];

  if (params.chartDataUrl) {
    const blob = dataUrlToBlob(params.chartDataUrl);
    if (blob) {
      try {
        const attachment = await saveImageFromBlob(blob, noteId, date, `${params.symbol}-chart.jpg`);
        attachments.push(attachment);
      } catch {
        // Non-fatal: still save the text note
      }
    }
  }

  const cleanPrompt = params.prompt.trim().slice(0, 72);
  const title = cleanPrompt
    ? `AI: ${cleanPrompt}`
    : `AI Analysis — ${params.symbol}`;

  const note: Note = {
    id: noteId,
    title,
    body: params.analysis.trim(),
    date,
    symbol: params.symbol,
    fullSymbol: params.fullSymbol,
    pinned: false,
    attachments,
    createdAt: nowIso,
    updatedAt: nowIso
  };

  await saveNotes([note, ...notes]);
}
