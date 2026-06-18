/**
 * Shell quoting helpers for codegen. Each targets one shell's escaping rules.
 * Best-effort for cmd (Windows quoting is genuinely ambiguous); bash and
 * PowerShell single-quote strategies are robust.
 */

/** bash single-quote: wrap in '...', escaping embedded ' as '\''. */
export function bashSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Windows cmd: double-quote, double internal quotes, escape % as %%. */
export function cmdQuote(s: string): string {
  return `"${s.replace(/%/g, '%%').replace(/"/g, '""')}"`;
}

/** PowerShell single-quote: wrap in '...', doubling embedded '. */
export function psSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `''`)}'`;
}
