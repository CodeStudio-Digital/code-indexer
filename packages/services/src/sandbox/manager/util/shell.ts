/**
 * Minimal POSIX shell quoting — wraps in single quotes and escapes
 * embedded single quotes by closing, escaping, reopening. Used for
 * argv fragments we assemble into `sh -c "…"` strings. Inputs come
 * from code, never from LLM/user, so we don't need to defend against
 * weird bytes beyond what the shell parser expects.
 */
export function shQuote(s: string): string {
  if (/^[a-zA-Z0-9_.\-/:@=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function truncateForLog(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)} …[+${s.length - max} bytes]` : s;
}
