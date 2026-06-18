/** Shared formatting for request rows (method color, status color, path). */
export const METHOD_COLOR: Record<string, string> = {
  GET: 'text-emerald-500', POST: 'text-amber-500', PUT: 'text-blue-500',
  PATCH: 'text-violet-500', DELETE: 'text-red-500', HEAD: 'text-muted-foreground', OPTIONS: 'text-muted-foreground',
};

export function statusColor(s: number | null): string {
  if (s == null) return 'text-muted-foreground';
  if (s < 300) return 'text-emerald-500';
  if (s < 400) return 'text-blue-500';
  if (s < 500) return 'text-amber-500';
  return 'text-red-500';
}

/** Strip protocol+host so the row shows just the path; '/' when empty. */
export function pathOnly(t: string): string {
  return t.replace(/^https?:\/\/[^/]+/i, '') || '/';
}
