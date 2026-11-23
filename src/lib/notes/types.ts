export interface NoteAttachment {
  id: string;
  filename: string;
  mimeType: string;
  createdAt: string;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  date: string; // YYYY-MM-DD (Africa/Nairobi)
  symbol: string; // e.g. "XAUUSD"
  fullSymbol: string; // e.g. "OANDA:XAUUSD"
  pinned: boolean;
  attachments: NoteAttachment[];
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  deletedAt?: string; // ISO 8601 when soft-deleted
}

const FULL_DAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
] as const;

const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
] as const;

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

export function makeNoteId(): string {
  return `nt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function makeAttachmentId(): string {
  return `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function todayNairobiIso(): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Nairobi',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === 'year')?.value ?? '2026';
    const m = parts.find((p) => p.type === 'month')?.value ?? '01';
    const d = parts.find((p) => p.type === 'day')?.value ?? '01';
    return `${y}-${m}-${d}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function formatDateHeading(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${FULL_DAYS[dt.getUTCDay()]}, ${FULL_MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
}

export function formatShortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${SHORT_MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${dt.getUTCFullYear()}`;
}

export function formatTime(isoTimestamp: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Nairobi',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(isoTimestamp));
  } catch {
    return '';
  }
}

export function isNoteEmpty(note: Note): boolean {
  return (
    note.title.trim().length === 0 &&
    note.body.trim().length === 0 &&
    note.attachments.length === 0
  );
}
