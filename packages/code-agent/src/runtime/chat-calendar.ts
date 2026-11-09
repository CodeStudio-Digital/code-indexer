const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string) {
  let format = formatters.get(zone);
  if (!format) { format = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }); formatters.set(zone, format); }
  return format;
}
export function wallTime(at: number, zone: string): string {
  const parts = Object.fromEntries(formatter(zone).formatToParts(at).map(row => [row.type, row.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
function field(text: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const item of text.split(',')) {
    if (!/^(\*|\d+|\d+-\d+)(\/\d+)?$/.test(item)) throw new Error('invalid_cron');
    const [range, stride] = item.split('/'); const step = stride ? Number(stride) : 1;
    const [start, end] = range === '*' ? [min, max] : range.includes('-') ? range.split('-').map(Number) : [Number(range), stride ? max : Number(range)];
    if (start < min || end > max || start > end || step < 1 || step > max - min + 1) throw new Error('invalid_cron');
    for (let n = start; n <= end; n += step) values.add(n);
  }
  return values;
}
/** Five-field local cron. UTC iteration skips nonexistent wall times; the
 * last wall key prevents a repeated DST hour from firing the same slot twice. */
export function nextCron(cron: string, timezone: string, after: number, previousWall?: string): number {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('invalid_cron: use minute hour day month weekday');
  const [minute, hour, day, month, week] = fields.map((f, i) => field(f, [0, 0, 1, 1, 0][i], [59, 23, 31, 12, 6][i]));
  const format = formatter(timezone);
  for (let at = Math.floor(after / 60000) * 60000 + 60000, end = at + 366 * 86400_000; at < end; at += 60000) {
    const p = Object.fromEntries(format.formatToParts(at).map(row => [row.type, row.value]));
    const dayMatches = fields[2] === '*' ? week.has(WEEKDAYS.indexOf(p.weekday))
      : fields[4] === '*' ? day.has(Number(p.day)) : day.has(Number(p.day)) || week.has(WEEKDAYS.indexOf(p.weekday));
    if (!month.has(Number(p.month)) || !dayMatches || !hour.has(Number(p.hour))) {
      at += (59 - Number(p.minute)) * 60000; continue;
    }
    if (minute.has(Number(p.minute)) && hour.has(Number(p.hour)) && month.has(Number(p.month)) && dayMatches
      && wallTime(at, timezone) !== previousWall) return at;
  }
  throw new Error('cron_has_no_occurrence_within_year');
}
