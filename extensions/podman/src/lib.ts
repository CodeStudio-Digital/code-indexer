/**
 * Shared Podman plugin helpers. Tools shell out through the granted `exec`
 * capability (`podman <argv>`) and reuse @mcp/podman-core to build argv and
 * parse `--format json` output — the SAME pure functions the company sandbox
 * runtime uses, so behavior never drifts between the IDE and company modes.
 *
 * Note: the plugin exec surface returns only `{ stdout, code }` (no stderr),
 * so failures surface as a non-zero exit with whatever the CLI put on stdout.
 */
import type {
  PluginEditorInvocationContext,
  PluginToolContext,
  PluginToolResult,
} from '@mcp/plugin-sdk/define.js';

export const CONTAINERFILE_EDITOR_PATTERNS = [
  'Dockerfile',
  'Dockerfile.*',
  'Containerfile',
  'Containerfile.*',
];

export const COMPOSE_EDITOR_PATTERNS = [
  'compose.yaml',
  'compose.yml',
  'compose.*.yaml',
  'compose.*.yml',
  'docker-compose.yml',
  'docker-compose.yaml',
  'docker-compose.*.yml',
  'docker-compose.*.yaml',
];

const CONTAINERFILE_BASENAME = /^(?:dockerfile|containerfile)(?:\.[^.]+)*$/i;
const COMPOSE_BASENAME = /^(?:docker-)?compose(?:\.[^.]+)*\.ya?ml$/i;

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

/** Editor metadata injected by an IDE editorAction gutter invocation. */
export function editorContext(args: Record<string, unknown>): PluginEditorInvocationContext | null {
  const raw = args._editor;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.path !== 'string' || typeof value.lineNumber !== 'number') return null;
  return {
    path: value.path,
    languageId: typeof value.languageId === 'string' ? value.languageId : 'plaintext',
    lineNumber: value.lineNumber,
    column: typeof value.column === 'number' ? value.column : 1,
    lineText: typeof value.lineText === 'string' ? value.lineText : '',
  };
}

/** Normalize a project-relative path without allowing host-path escapes. */
export function projectRelativePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  const normalized = raw.replace(/\\/g, '/');
  // Reject POSIX/UNC/root-relative paths and Windows drive absolute/relative paths.
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;
  const segments = normalized.split('/');
  if (segments.includes('..')) return null;
  const clean = segments.filter((segment) => segment && segment !== '.');
  return clean.length ? clean.join('/') : null;
}

function artifactPath(value: unknown, basename: RegExp): string | null {
  const path = projectRelativePath(value);
  if (!path) return null;
  const name = path.split('/').pop() ?? '';
  return basename.test(name) ? path : null;
}

/** A safe relative Dockerfile/Containerfile path, including dotted variants. */
export function containerfilePath(value: unknown): string | null {
  return artifactPath(value, CONTAINERFILE_BASENAME);
}

/** A safe relative Compose path, including multiple dotted qualifiers. */
export function composeFilePath(value: unknown): string | null {
  return artifactPath(value, COMPOSE_BASENAME);
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
