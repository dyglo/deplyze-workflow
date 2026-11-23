export const DEFAULT_TIMEZONE = 'Africa/Nairobi';

export function isIsoDate(val: string | null | undefined): val is string {
  return Boolean(val && /^\d{4}-\d{2}-\d{2}$/.test(val));
}

export function resolveTimeZone(tzParam: string | null | undefined): string {
  if (!tzParam) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tzParam }).format(new Date(0));
    return tzParam;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

export function addDays(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function getWeekStart(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0=Sun..6=Sat
  const offset = dow === 0 ? -6 : 1 - dow;
  dt.setUTCDate(dt.getUTCDate() + offset);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

export function formatUtcDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function getTodayInTz(tz: string, now: Date = new Date()): string {
  return formatPartsInTz(now, tz).date;
}

export function formatPartsInTz(date: Date, tz: string): { date: string; time: string } {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const parts = formatter.formatToParts(date);
  let year = '1970';
  let month = '01';
  let day = '01';
  let hour = '00';
  let minute = '00';
  for (const p of parts) {
    if (p.type === 'year') year = p.value;
    else if (p.type === 'month') month = p.value;
    else if (p.type === 'day') day = p.value;
    else if (p.type === 'hour') hour = p.value === '24' ? '00' : p.value;
    else if (p.type === 'minute') minute = p.value;
  }
  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`
  };
}

/**
 * Converts a wall-clock date/time in America/New_York (handles EST/EDT DST)
 * to Unix timestamp in seconds (UTC).
 */
export function easternTimeToUnixSeconds(dateIso: string, hour: number, minute: number): number {
  const [year, month, day] = dateIso.split('-').map(Number);
  // First guess: treat wall-clock as UTC, then measure America/New_York's offset at that instant
  const approxUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset1 = getTimeZoneOffsetMinutes(new Date(approxUtcMs), 'America/New_York');
  const candidateMs = approxUtcMs - offset1 * 60_000;
  // Re-check offset at the adjusted instant to handle DST transition days cleanly
  const offset2 = getTimeZoneOffsetMinutes(new Date(candidateMs), 'America/New_York');
  const finalMs = approxUtcMs - offset2 * 60_000;
  return Math.floor(finalMs / 1000);
}

/** Returns timezone offset in minutes relative to UTC (e.g., EST = -300, EDT = -240, EAT = +180). */
function getTimeZoneOffsetMinutes(date: Date, tz: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = formatter.formatToParts(date);
  let y = 1970,
    m = 1,
    d = 1,
    hh = 0,
    mm = 0,
    ss = 0;
  for (const p of parts) {
    if (p.type === 'year') y = Number(p.value);
    else if (p.type === 'month') m = Number(p.value);
    else if (p.type === 'day') d = Number(p.value);
    else if (p.type === 'hour') hh = p.value === '24' ? 0 : Number(p.value);
    else if (p.type === 'minute') mm = Number(p.value);
    else if (p.type === 'second') ss = Number(p.value);
  }
  const asUtcMs = Date.UTC(y, m - 1, d, hh, mm, ss);
  return Math.round((asUtcMs - date.getTime()) / 60_000);
}
