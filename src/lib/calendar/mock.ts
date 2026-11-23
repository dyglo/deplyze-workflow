import type { CountryCode } from './flags';

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
  date: string; // YYYY-MM-DD (Africa/Nairobi)
  time: string; // HH:MM (Africa/Nairobi)
  title: string;
  country: CountryCode;
  impact: EventImpact;
  flagged?: boolean;
  prior?: string;
  forecast?: string;
}

export interface CalendarDay {
  iso: string; // YYYY-MM-DD
  shortLabel: string; // e.g. "Mon 23"
  fullHeading: string; // e.g. "Monday, November 23"
  counts: DayCounts;
}

export const CALENDAR_TIMEZONE = 'Africa/Nairobi';
export const TODAY_ISO = '2026-11-23';

const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const FULL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const FULL_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
] as const;

const MOCK_COUNTS: Record<string, DayCounts> = {
  '2026-11-23': { economic: 45, earnings: 651, dividends: 827, ipo: 0 },
  '2026-11-24': { economic: 52, earnings: 496, dividends: 485, ipo: 0 },
  '2026-11-25': { economic: 94, earnings: 439, dividends: 699, ipo: 1 },
  '2026-11-26': { economic: 26, earnings: 252, dividends: 421, ipo: 0 },
  '2026-11-27': { economic: 74, earnings: 195, dividends: 804, ipo: 0 },
  '2026-11-28': { economic: 4, earnings: 3, dividends: 0, ipo: 0 },
  '2026-11-29': { economic: 6, earnings: 2, dividends: 0, ipo: 0 }
};

const MOCK_EVENTS: Record<string, EconomicEvent[]> = {
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
      time: '08:00',
      title: 'HSBC Manufacturing PMI Flash',
      country: 'IN',
      impact: 'medium',
      prior: '57.5',
      forecast: '57.2'
    },
    {
      id: '2026-11-23-7',
      date: '2026-11-23',
      time: '11:30',
      title: 'HCOB Germany Manufacturing PMI Flash',
      country: 'DE',
      impact: 'high',
      prior: '46.0',
      forecast: '46.4'
    },
    {
      id: '2026-11-23-8',
      date: '2026-11-23',
      time: '12:00',
      title: 'HCOB Eurozone Composite PMI Flash',
      country: 'EU',
      impact: 'high',
      prior: '50.0',
      forecast: '50.2'
    },
    {
      id: '2026-11-23-9',
      date: '2026-11-23',
      time: '12:30',
      title: 'S&P Global UK Services PMI Flash',
      country: 'GB',
      impact: 'high',
      prior: '52.0',
      forecast: '51.8'
    },
    {
      id: '2026-11-23-10',
      date: '2026-11-23',
      time: '17:45',
      title: 'S&P Global US Manufacturing PMI Flash',
      country: 'US',
      impact: 'high',
      prior: '48.5',
      forecast: '48.8'
    },
    {
      id: '2026-11-23-11',
      date: '2026-11-23',
      time: '17:45',
      title: 'S&P Global US Services PMI Flash',
      country: 'US',
      impact: 'high',
      prior: '55.0',
      forecast: '55.2'
    },
    {
      id: '2026-11-23-12',
      date: '2026-11-23',
      time: '18:00',
      title: 'Michigan Consumer Sentiment Final',
      country: 'US',
      impact: 'medium',
      prior: '73.0',
      forecast: '73.5'
    }
  ],
  '2026-11-24': [
    {
      id: '2026-11-24-1',
      date: '2026-11-24',
      time: '02:50',
      title: 'BoJ Core CPI YoY',
      country: 'JP',
      impact: 'medium',
      prior: '1.9%',
      forecast: '2.0%'
    },
    {
      id: '2026-11-24-2',
      date: '2026-11-24',
      time: '12:00',
      title: 'Ifo Business Climate',
      country: 'DE',
      impact: 'high',
      prior: '86.5',
      forecast: '86.8'
    },
    {
      id: '2026-11-24-3',
      date: '2026-11-24',
      time: '18:00',
      title: 'CB Consumer Confidence',
      country: 'US',
      impact: 'high',
      prior: '108.7',
      forecast: '109.5'
    },
    {
      id: '2026-11-24-4',
      date: '2026-11-24',
      time: '18:00',
      title: 'New Home Sales',
      country: 'US',
      impact: 'medium',
      prior: '738K',
      forecast: '725K'
    }
  ],
  '2026-11-25': [
    {
      id: '2026-11-25-1',
      date: '2026-11-25',
      time: '03:30',
      title: 'Monthly CPI Indicator YoY',
      country: 'AU',
      impact: 'high',
      prior: '2.1%',
      forecast: '2.3%'
    },
    {
      id: '2026-11-25-2',
      date: '2026-11-25',
      time: '16:30',
      title: 'GDP Growth Rate QoQ 2nd Est',
      country: 'US',
      impact: 'high',
      prior: '2.8%',
      forecast: '2.8%'
    },
    {
      id: '2026-11-25-3',
      date: '2026-11-25',
      time: '16:30',
      title: 'Initial Jobless Claims',
      country: 'US',
      impact: 'high',
      prior: '213K',
      forecast: '215K'
    },
    {
      id: '2026-11-25-4',
      date: '2026-11-25',
      time: '18:00',
      title: 'Core PCE Price Index YoY',
      country: 'US',
      impact: 'high',
      prior: '2.7%',
      forecast: '2.8%'
    }
  ],
  '2026-11-26': [
    {
      id: '2026-11-26-1',
      date: '2026-11-26',
      time: '10:00',
      title: 'GfK Consumer Confidence',
      country: 'DE',
      impact: 'medium',
      prior: '-18.3',
      forecast: '-18.6'
    },
    {
      id: '2026-11-26-2',
      date: '2026-11-26',
      time: '13:00',
      title: 'Eurozone Economic Sentiment',
      country: 'EU',
      impact: 'medium',
      prior: '95.6',
      forecast: '95.9'
    },
    {
      id: '2026-11-26-3',
      date: '2026-11-26',
      time: '16:30',
      title: 'Average Weekly Earnings YoY',
      country: 'CA',
      impact: 'low',
      prior: '4.6%'
    }
  ],
  '2026-11-27': [
    {
      id: '2026-11-27-1',
      date: '2026-11-27',
      time: '02:30',
      title: 'Tokyo Core CPI YoY',
      country: 'JP',
      impact: 'high',
      prior: '1.8%',
      forecast: '2.0%'
    },
    {
      id: '2026-11-27-2',
      date: '2026-11-27',
      time: '13:00',
      title: 'Eurozone Inflation Rate YoY Flash',
      country: 'EU',
      impact: 'high',
      prior: '2.0%',
      forecast: '2.2%'
    },
    {
      id: '2026-11-27-3',
      date: '2026-11-27',
      time: '16:30',
      title: 'GDP Growth Rate QoQ',
      country: 'CA',
      impact: 'high',
      prior: '0.5%',
      forecast: '0.3%'
    }
  ],
  '2026-11-28': [
    {
      id: '2026-11-28-1',
      date: '2026-11-28',
      time: '09:00',
      title: 'Weekly FX Reserves Update',
      country: 'IN',
      impact: 'low',
      prior: '$675.7B'
    }
  ],
  '2026-11-29': [
    {
      id: '2026-11-29-1',
      date: '2026-11-29',
      time: '03:00',
      title: 'Jibun Bank Manufacturing PMI Final',
      country: 'JP',
      impact: 'low',
      prior: '49.0'
    }
  ]
};

export function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatIsoDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(iso: string, delta: number): string {
  const dt = parseIsoDate(iso);
  dt.setUTCDate(dt.getUTCDate() + delta);
  return formatIsoDate(dt);
}

/** Returns the Monday (ISO) of the week containing `iso`. */
export function getWeekStart(iso: string): string {
  const dt = parseIsoDate(iso);
  const dow = dt.getUTCDay(); // 0=Sun..6=Sat
  const offset = dow === 0 ? -6 : 1 - dow;
  dt.setUTCDate(dt.getUTCDate() + offset);
  return formatIsoDate(dt);
}

export function formatWeekRange(weekStartIso: string): string {
  const start = parseIsoDate(weekStartIso);
  const end = parseIsoDate(addDays(weekStartIso, 6));
  const startMonth = SHORT_MONTHS[start.getUTCMonth()];
  const endMonth = SHORT_MONTHS[end.getUTCMonth()];
  const startDay = start.getUTCDate();
  const endDay = end.getUTCDate();

  if (start.getUTCMonth() === end.getUTCMonth()) {
    return `${startMonth} ${startDay} — ${endDay}`;
  }
  return `${startMonth} ${startDay} — ${endMonth} ${endDay}`;
}

function fallbackCounts(iso: string): DayCounts {
  const dt = parseIsoDate(iso);
  const dow = dt.getUTCDay();
  const seed = dt.getUTCDate() + dt.getUTCMonth() * 7;
  if (dow === 0 || dow === 6) {
    return {
      economic: 3 + (seed % 5),
      earnings: seed % 4,
      dividends: 0,
      ipo: 0
    };
  }
  return {
    economic: 24 + ((seed * 11) % 65),
    earnings: 140 + ((seed * 37) % 420),
    dividends: 210 + ((seed * 53) % 580),
    ipo: dow === 3 && seed % 2 === 0 ? 1 : 0
  };
}

export function getWeekDays(weekStartIso: string): CalendarDay[] {
  return Array.from({ length: 7 }, (_, i) => {
    const iso = addDays(weekStartIso, i);
    const dt = parseIsoDate(iso);
    const dow = dt.getUTCDay();
    const dayNum = dt.getUTCDate();
    const monthName = FULL_MONTHS[dt.getUTCMonth()];
    return {
      iso,
      shortLabel: `${SHORT_DAYS[dow]} ${dayNum}`,
      fullHeading: `${FULL_DAYS[dow]}, ${monthName} ${dayNum}`,
      counts: MOCK_COUNTS[iso] ?? fallbackCounts(iso)
    };
  });
}

export function getEconomicEvents(iso: string): EconomicEvent[] {
  if (MOCK_EVENTS[iso]) return MOCK_EVENTS[iso];

  const dt = parseIsoDate(iso);
  const dow = dt.getUTCDay();
  if (dow === 0 || dow === 6) {
    return [
      {
        id: `${iso}-wknd-1`,
        date: iso,
        time: '09:00',
        title: 'Weekly Market Positioning Report',
        country: 'US',
        impact: 'low',
        prior: '245.1K'
      }
    ];
  }

  return [
    {
      id: `${iso}-gen-1`,
      date: iso,
      time: '09:00',
      title: 'Industrial Production MoM',
      country: 'DE',
      impact: 'medium',
      prior: '0.4%',
      forecast: '0.6%'
    },
    {
      id: `${iso}-gen-2`,
      date: iso,
      time: '12:00',
      title: 'Eurozone Trade Balance',
      country: 'EU',
      impact: 'medium',
      prior: '€12.5B',
      forecast: '€13.1B'
    },
    {
      id: `${iso}-gen-3`,
      date: iso,
      time: '16:30',
      title: 'US Retail Sales MoM',
      country: 'US',
      impact: 'high',
      prior: '0.4%',
      forecast: '0.3%'
    }
  ];
}
