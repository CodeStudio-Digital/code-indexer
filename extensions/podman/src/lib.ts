/**
 * Shared Podman plugin helpers. Tools shell out through the granted `exec`
 * capability (`podman <argv>`) and reuse @mcp/podman-core to build argv and
 * parse `--format json` output — the SAME pure functions the company sandbox
 * runtime uses, so behavior never drifts between the IDE and company modes.
 *
 * Note: the plugin exec surface returns only `{ stdout, code }` (no stderr),
 * so failures surface as a non-zero exit with whatever the CLI put on stdout.
 */
import type { PluginToolContext, PluginToolResult } from '@mcp/plugin-sdk/define.js';

/** Run `podman <args>` in the project dir. Throws only if exec isn't granted. */
export async function podman(
  ctx: PluginToolContext,
  args: string[],
): Promise<{ stdout: string; code: number | null }> {
  if (!ctx.exec) throw new Error('exec capability not granted');
  return ctx.exec.run('podman', args, { cwd: ctx.cwd });
}

/** Run a read command and parse its JSON stdout, throwing on a non-zero exit. */
export async function podmanJson<T>(
  ctx: PluginToolContext,
  args: string[],
  parse: (raw: string) => T,
): Promise<T> {
  const r = await podman(ctx, args);
  if (r.code !== 0) throw new Error(r.stdout.trim() || `podman ${args[0]} failed (exit ${r.code})`);
  return parse(r.stdout);
}

/** Run a mutating command; return a uniform result with the trimmed stdout. */
export async function podmanRun(
  ctx: PluginToolContext,
  args: string[],
  okMessage: (stdout: string) => string,
): Promise<PluginToolResult> {
  const r = await podman(ctx, args);
  const out = r.stdout.trim();
  if (r.code !== 0) return fail(out || `podman ${args[0]} failed (exit ${r.code})`);
  return ok(okMessage(out));
}

export const ok = (content: string, data?: unknown): PluginToolResult => ({
  content,
  ...(data === undefined ? {} : { data }),
});

export const fail = (content: string): PluginToolResult => ({ content, isError: true });

/** Format a list result for both the agent (content) and the webview (data.rows). */
export function list<T>(
  items: T[] | null | undefined,
  render: (x: T) => string,
  empty: string,
): PluginToolResult {
  const rows = items ?? [];
  return { content: rows.length ? rows.map(render).join('\n') : empty, data: { rows } };
}

export function details(content: string, value: unknown): PluginToolResult {
  return { content, data: { details: value } };
}

export function reqString(args: Record<string, unknown>, key: string): string {
  const value = String(args[key] ?? '').trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const value = String(args[key] ?? '').trim();
  return value || undefined;
}

export function optNumber(args: Record<string, unknown>, key: string): number | undefined {
  const raw = args[key];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
  return n;
}

export function optBool(args: Record<string, unknown>, key: string): boolean {
  const raw = args[key];
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return raw === 'true' || raw === '1' || raw === 'yes';
  return false;
}

/**
 * Coerce a value that may arrive as an array, a JSON array string, or a
 * newline/comma-separated string into a clean string[] (e.g. ports, volumes,
 * command argv). Empty entries are dropped.
 */
export function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  const s = String(value ?? '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s) as unknown;
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
    } catch {
      /* fall through to delimiter split */
    }
  }
  return s
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Coerce env/labels that may arrive as an object or `KEY=VALUE` lines into a
 * record. Lines without `=` are ignored.
 */
export function toRecord(value: unknown): Record<string, string> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = String(v);
    return out;
  }
  const out: Record<string, string> = {};
  for (const line of toList(value)) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}
