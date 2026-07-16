/**
 * Centralized date parsing + formatting for the dashboard.
 *
 * Why this exists: SQLite emits timestamps as 'YYYY-MM-DD HH:MM:SS' in UTC
 * WITHOUT a trailing 'Z'. V8 parses that space-separated form as *local* time,
 * so every such value was rendered shifted by the machine's UTC offset — enough
 * to cross a day boundary and show the wrong date. `parseDbDate` normalizes
 * every shape we deal with (epoch ms, ISO with 'Z', ISO with numeric offset,
 * SQLite UTC-without-zone, and date-only) to a correct absolute instant; the
 * formatters below then render it in the machine's LOCAL timezone via the
 * toLocale* family. Route all displayed dates through here instead of calling
 * `new Date(str)` inline.
 */
import i18n from '../i18n/index.js';

export type DateInput = string | number | Date | null | undefined;

/**
 * Parse any timestamp shape into a Date in the correct absolute instant, or
 * null when the input is missing/unparseable. A bare 'YYYY-MM-DD HH:MM:SS'
 * (no zone) is treated as UTC to match SQLite's `datetime('now')`.
 */
export function parseDbDate(value: DateInput): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = value.trim();
  if (!s) return null;
  // Epoch milliseconds encoded as a string.
  if (/^\d+$/.test(s)) {
    const d = new Date(Number(s));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // Date-only ('YYYY-MM-DD'): pin to LOCAL midnight so the calendar day never
  // shifts across timezones (appending a UTC time would move it a day).
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) {
    const d = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // Datetime. Swap SQLite's space separator for 'T' and, when there is no
  // explicit zone, assume UTC (SQLite datetime('now') is UTC).
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
  let iso = s.includes('T') ? s : s.replace(' ', 'T');
  if (!hasZone) iso += 'Z';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Local date + time. Returns `fallback` (default '') when unparseable. */
export function formatDateTime(value: DateInput, options?: Intl.DateTimeFormatOptions, locale?: string, fallback = ''): string {
  const d = parseDbDate(value);
  return d ? d.toLocaleString(locale, options) : fallback;
}

/** Local calendar date only. */
export function formatDay(value: DateInput, options?: Intl.DateTimeFormatOptions, locale?: string, fallback = ''): string {
  const d = parseDbDate(value);
  return d ? d.toLocaleDateString(locale, options) : fallback;
}

/** Local wall-clock time only. */
export function formatClock(value: DateInput, options?: Intl.DateTimeFormatOptions, locale?: string, fallback = ''): string {
  const d = parseDbDate(value);
  return d ? d.toLocaleTimeString(locale, options) : fallback;
}

/** Relative "3m ago" phrasing, falling back to a local date past 30 days. */
export function formatRelativeTime(value: DateInput): string {
  const d = parseDbDate(value);
  if (!d) return i18n.t('time.never');
  const diff = Math.max(0, Date.now() - d.getTime());
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return i18n.t('time.secondsAgo', { count: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return i18n.t('time.minutesAgo', { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return i18n.t('time.hoursAgo', { count: hr });
  const day = Math.floor(hr / 24);
  if (day < 30) return i18n.t('time.daysAgo', { count: day });
  return d.toLocaleDateString(i18n.language);
}
