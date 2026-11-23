export type CalendarCategory = 'economic' | 'earnings' | 'dividends' | 'ipo';
export type EventImpact = 'low' | 'medium' | 'high';

export interface DayCounts {
  economic: number;
  earnings: number;
  dividends: number;
  ipo: number;
}

export interface EconomicEvent {
  id: string;
  date: string;
  time: string;
  title: string;
  country: string;
  impact: EventImpact;
  flagged?: boolean;
  prior?: string;
  forecast?: string;
}

export interface CalendarDaySummary {
  iso: string;
  counts: DayCounts;
}

const DEFAULT_TODAY = '2026-11-23';

const SEED_COUNTS: Record<string, DayCounts> = {
  '2026-11-23': { economic: 45, earnings: 651, dividends: 827, ipo: 0 },
  '2026-11-24': { economic: 52, earnings: 496, dividends: 485, ipo: 0 },
  '2026-11-25': { economic: 94, earnings: 439, dividends: 699, ipo: 1 },
  '2026-11-26': { economic: 26, earnings: 252, dividends: 421, ipo: 0 },
  '2026-11-27': { economic: 74, earnings: 195, dividends: 804, ipo: 0 },
  '2026-11-28': { economic: 4, earnings: 3, dividends: 0, ipo: 0 },
  '2026-11-29': { economic: 6, earnings: 2, dividends: 0, ipo: 0 }
};

const SEED_EVENTS: Record<string, EconomicEvent[]> = {
  '2026-11-23': [
    {
      id: '2026-11-23-1',
      date: '2026-11-23',
      time: '01:00',
      title: 'S&P Global Composite PMI Flash',
      country: 'AU',
      impact: 'medium',
      flagged: true
    },
    {
      id: '2026-11-23-2',
      date: '2026-11-23',
      time: '01:00',
      title: 'S&P Global Manufacturing PMI Flash',
      country: 'AU',
      impact: 'medium',
      flagged: true
    },
    {
      id: '2026-11-23-3',
      date: '2026-11-23',
      time: '01:00',
      title: 'S&P Global Services PMI Flash',
      country: 'AU',
      impact: 'medium',
      flagged: true
    },
    {
      id: '2026-11-23-4',
      date: '2026-11-23',
      time: '06:00',
      title: 'M2 Money Supply YoY',
      country: 'ID',
      impact: 'low',
      prior: '8.3%'
    },
    {
      id: '2026-11-23-5',
      date: '2026-11-23',
      time: '08:00',
      title: 'HSBC Composite PMI Flash',
      country: 'IN',
      impact: 'medium',
      forecast: '56.3'
    },
    {
      id: '2026-11-23-6',
      date: '2026-11-23',
      time: '11:30',
      title: 'HCOB Germany Manufacturing PMI Flash',
      country: 'DE',
      impact: 'high',
      prior: '46.0',
      forecast: '46.4'
    },
    {
      id: '2026-11-23-7',
      date: '2026-11-23',
      time: '12:00',
      title: 'HCOB Eurozone Composite PMI Flash',
      country: 'EU',
      impact: 'high',
      prior: '50.0',
      forecast: '50.2'
    },
    {
      id: '2026-11-23-8',
      date: '2026-11-23',
      time: '17:45',
      title: 'S&P Global US Manufacturing PMI Flash',
      country: 'US',
      impact: 'high',
      prior: '48.5',
      forecast: '48.8'
    }
  ]
};

function isIsoDate(val: string | null): val is string {
  return Boolean(val && /^\d{4}-\d{2}-\d{2}$/.test(val));
}

function addDays(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function getCalendarWeekPayload(startParam: string | null) {
  const weekStart = isIsoDate(startParam) ? startParam : DEFAULT_TODAY;
  const days: CalendarDaySummary[] = Array.from({ length: 7 }, (_, i) => {
    const iso = addDays(weekStart, i);
    return {
      iso,
      counts: SEED_COUNTS[iso] ?? { economic: 0, earnings: 0, dividends: 0, ipo: 0 }
    };
  });

  return {
    timezone: 'Africa/Nairobi',
    weekStart,
    days
  };
}

export function getCalendarEventsPayload(dateParam: string | null, categoryParam: string | null) {
  const date = isIsoDate(dateParam) ? dateParam : DEFAULT_TODAY;
  const category = (
    categoryParam === 'earnings' ||
    categoryParam === 'dividends' ||
    categoryParam === 'ipo'
      ? categoryParam
      : 'economic'
  ) as CalendarCategory;

  return {
    timezone: 'Africa/Nairobi',
    date,
    category,
    events: category === 'economic' ? (SEED_EVENTS[date] ?? []) : []
  };
}
