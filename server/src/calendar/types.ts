export type CalendarCategory = 'economic' | 'earnings' | 'dividends' | 'ipo';
export type EventImpact = 'low' | 'medium' | 'high';
export type CountryCode =
  | 'AU'
  | 'CA'
  | 'CH'
  | 'CN'
  | 'DE'
  | 'EU'
  | 'GB'
  | 'ID'
  | 'IN'
  | 'JP'
  | 'NZ'
  | 'US';

export type EventSource = 'showmytrades' | 'fred' | 'fed';

export interface DayCounts {
  economic: number;
  earnings: number;
  dividends: number;
  ipo: number;
}

/** Canonical UTC event stored in caches and archives. */
export interface RawEconomicEvent {
  id: string;
  ts: number; // Unix seconds (UTC)
  isoTime: string; // ISO 8601 UTC
  title: string;
  country: CountryCode;
  currency: string;
  impact: EventImpact;
  prior?: string;
  forecast?: string;
  actual?: string;
  source: EventSource;
}

/** Event serialized for the client in a requested IANA timezone. */
export interface EconomicEvent {
  id: string;
  date: string; // YYYY-MM-DD in requested tz
  time: string; // HH:MM in requested tz
  ts: number; // Unix seconds (UTC)
  isoTime: string;
  title: string;
  country: CountryCode;
  impact: EventImpact;
  flagged?: boolean;
  prior?: string;
  forecast?: string;
  actual?: string;
  source: EventSource;
}

export interface CalendarDaySummary {
  iso: string;
  counts: DayCounts;
}

export interface CalendarWeekPayload {
  timezone: string;
  weekStart: string;
  sources: EventSource[];
  fallbackActive: boolean;
  days: CalendarDaySummary[];
  eventsByDate: Record<string, EconomicEvent[]>;
}

export interface CalendarEventsPayload {
  timezone: string;
  date: string;
  category: CalendarCategory;
  sources: EventSource[];
  fallbackActive: boolean;
  events: EconomicEvent[];
}
