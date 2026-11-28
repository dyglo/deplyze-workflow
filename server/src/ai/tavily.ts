import type { AiSourceLink } from './types.js';

const TAVILY_URL = 'https://api.tavily.com/search';
const TIMEOUT_MS = 12_000;

export interface TavilySearchResult {
  query: string;
  answer?: string;
  sources: AiSourceLink[];
  snippets: string;
}

interface TavilyApiItem {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
}

interface TavilyApiResponse {
  answer?: string;
  results?: TavilyApiItem[];
}

export function isTavilyConfigured(): boolean {
  return Boolean((process.env.TAVILY_API_KEY ?? '').trim());
}

export async function runTavilyFinanceSearch(
  query: string,
  options?: {
    topic?: 'finance' | 'news' | 'general';
    maxResults?: number;
    days?: number;
    startDate?: string; // YYYY-MM-DD
    endDate?: string; // YYYY-MM-DD
    includeDomains?: string[];
  }
): Promise<TavilySearchResult | null> {
  const apiKey = (process.env.TAVILY_API_KEY ?? '').trim();
  if (!apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const hasDateBounds = Boolean(options?.startDate || options?.endDate);
  const payload: Record<string, unknown> = {
    query,
    topic: options?.topic ?? 'news',
    search_depth: 'basic',
    max_results: options?.maxResults ?? 5,
    include_answer: true
  };

  if (hasDateBounds) {
    if (options?.startDate) payload.start_date = options.startDate;
    if (options?.endDate) payload.end_date = options.endDate;
  } else {
    payload.time_range = 'week';
    payload.days = options?.days ?? 7;
  }

  if (options?.includeDomains && options.includeDomains.length > 0) {
    payload.include_domains = options.includeDomains;
  }

  try {
    const res = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!res.ok) {
      console.warn(`[ai:tavily] HTTP ${res.status}`);
      return null;
    }

    const body = (await res.json()) as TavilyApiResponse;
    const rawItems = Array.isArray(body.results) ? body.results : [];

    const sources: AiSourceLink[] = [];
    const lines: string[] = [];

    if (body.answer && body.answer.trim()) {
      lines.push(`Tavily Summary: ${body.answer.trim()}`);
    }

    for (let i = 0; i < rawItems.length; i++) {
      const item = rawItems[i];
      const title = (item.title ?? '').trim();
      const url = (item.url ?? '').trim();
      const content = (item.content ?? '').replace(/\s+/g, ' ').trim();
      if (!title || !url) continue;

      sources.push({
        title,
        url,
        publishedDate: item.published_date?.trim() || undefined
      });
      const dateTag = item.published_date ? ` (${item.published_date})` : '';
      lines.push(`[${i + 1}] ${title}${dateTag}\nURL: ${url}\nSnippet: ${content.slice(0, 420)}`);
    }

    return {
      query,
      answer: body.answer?.trim() || undefined,
      sources,
      snippets: lines.join('\n\n')
    };
  } catch (err) {
    console.warn('[ai:tavily] search failed:', (err as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
