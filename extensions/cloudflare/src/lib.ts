/**
 * Shared Cloudflare plugin helpers. The plugin uses a pasted API token stored
 * in plugin storage for REST calls and injects the same token/account into
 * wrangler for deploy/login/tail flows.
 */
import type { PluginToolContext, PluginToolResult } from '@mcp/plugin-sdk/define.js';

const API = 'https://api.cloudflare.com/client/v4';

/**
 * How the project deploys to Cloudflare — drives which build/deploy commands
 * the plugin runs.
 *   - 'opennext': Next.js via @opennextjs/cloudflare (build step + own CLI)
 *   - 'pages':    Cloudflare Pages
 *   - 'worker':   a plain Worker (wrangler deploy)
 *   - null:       not a Cloudflare project
 */
export type CfDeployKind = 'opennext' | 'pages' | 'worker' | null;

export interface CfDetect {
  isCloudflare: boolean;
  configPath: string | null;
  workerName: string | null;
  packageName: string | null;
  /** Detected deploy model; null when not a Cloudflare project. */
  deployKind: CfDeployKind;
  /** Present when an OpenNext config file was found at the root. */
  openNextConfig: string | null;
}

interface CfError {
  message?: string;
  code?: number;
}

interface CfEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: CfError[];
  messages?: CfError[];
  result_info?: {
    page?: number;
    per_page?: number;
    total_pages?: number;
    total_count?: number;
    count?: number;
  };
}

export interface D1DatabaseRef {
  uuid: string;
  name: string;
}

export interface D1QueryResult {
  database: D1DatabaseRef;
  rows: Array<Record<string, unknown>>;
  columns: string[];
  meta?: unknown;
  raw: unknown;
}

export async function getToken(ctx: PluginToolContext): Promise<string | null> {
  return ctx.storage ? ctx.storage.get('apiToken') : null;
}

export async function getAccountId(ctx: PluginToolContext): Promise<string | null> {
  return ctx.storage ? ctx.storage.get('accountId') : null;
}

function apiUrl(path: string): string {
  return path.startsWith('http') ? path : `${API}${path.startsWith('/') ? path : `/${path}`}`;
}

function headerRecord(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((value, key) => {
      out[key] = value;
    });
  } else if (Array.isArray(h)) {
    for (const [key, value] of h) out[key] = value;
  } else {
    Object.assign(out, h as Record<string, string>);
  }
  return out;
}

async function authedFetch(
  ctx: PluginToolContext,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const token = await getToken(ctx);
  if (!token) throw new Error('no Cloudflare API token set (paste one in the panel)');
  const headers = headerRecord(init);
  headers.authorization = `Bearer ${token}`;
  if (init?.body && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
    headers['content-type'] = 'application/json';
  }
  return ctx.fetch(apiUrl(path), { ...init, headers });
}

function errorMessage(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as CfEnvelope<unknown>;
    const messages = [...(body.errors ?? []), ...(body.messages ?? [])]
      .map((e) => e.message ?? (e.code != null ? String(e.code) : ''))
      .filter(Boolean);
    if (messages.length) return messages.join('; ');
  } catch {
    /* fall through to text/status */
  }
  return text.trim() || `HTTP ${status}`;
}

async function cfEnvelope<T>(
  ctx: PluginToolContext,
  path: string,
  init?: RequestInit,
): Promise<CfEnvelope<T>> {
  const res = await authedFetch(ctx, path, init);
  const text = await res.text();
  let body: CfEnvelope<T>;
  try {
    body = text ? (JSON.parse(text) as CfEnvelope<T>) : {};
  } catch {
    if (!res.ok) throw new Error(`Cloudflare API: ${text || `HTTP ${res.status}`}`);
    throw new Error(`Cloudflare API returned non-JSON response for ${path}`);
  }
  if (!res.ok || body.success === false) {
    throw new Error(`Cloudflare API: ${errorMessage(res.status, text)}`);
  }
  return body;
}

export async function cfFetch<T = unknown>(
  ctx: PluginToolContext,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const body = await cfEnvelope<T>(ctx, path, init);
  return body.result as T;
}

export async function cfText(
  ctx: PluginToolContext,
  path: string,
  init?: RequestInit,
): Promise<string> {
  const res = await authedFetch(ctx, path, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`Cloudflare API: ${errorMessage(res.status, text)}`);
  return text;
}

function pagedPath(path: string, page: number, perPage: number): string {
  const sep = path.includes('?') ? '&' : '?';
  const hasPage = /[?&]page=/.test(path);
  const hasPer = /[?&]per_page=/.test(path);
  return `${path}${hasPage ? '' : `${sep}page=${page}`}${hasPer ? '' : `${hasPage ? '&' : '&'}per_page=${perPage}`}`;
}

export async function cfPaged<T>(
  ctx: PluginToolContext,
  path: string,
  perPage = 100,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; page < 1000; page += 1) {
    const body = await cfEnvelope<T[]>(ctx, pagedPath(path, page, perPage));
    rows.push(...((body.result ?? []) as T[]));
    const info = body.result_info;
    if (!info?.total_pages || page >= info.total_pages) break;
  }
  return rows;
}

export async function cfAcct<T = unknown>(
  ctx: PluginToolContext,
  suffix: string,
  init?: RequestInit,
): Promise<T> {
  const acct = await getAccountId(ctx);
  if (!acct) throw new Error('no account selected — run whoami first');
  return cfFetch<T>(ctx, `/accounts/${acct}${suffix}`, init);
}

export async function cfAcctText(
  ctx: PluginToolContext,
  suffix: string,
  init?: RequestInit,
): Promise<string> {
  const acct = await getAccountId(ctx);
  if (!acct) throw new Error('no account selected — run whoami first');
  return cfText(ctx, `/accounts/${acct}${suffix}`, init);
}

export async function cfAcctPaged<T>(
  ctx: PluginToolContext,
  suffix: string,
  perPage = 100,
): Promise<T[]> {
  const acct = await getAccountId(ctx);
  if (!acct) throw new Error('no account selected — run whoami first');
  return cfPaged<T>(ctx, `/accounts/${acct}${suffix}`, perPage);
}

export async function wrangler(
  ctx: PluginToolContext,
  args: string[],
): Promise<{ stdout: string; code: number | null }> {
  if (!ctx.exec) throw new Error('exec capability not granted');
  const token = await getToken(ctx);
  const accountId = await getAccountId(ctx);
  const env: Record<string, string> = {};
  if (token) env.CLOUDFLARE_API_TOKEN = token;
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  return ctx.exec.run('npx', ['wrangler', ...args], { cwd: ctx.cwd, env });
}

export const ok = (content: string, data?: unknown): PluginToolResult => ({
  content,
  ...(data === undefined ? {} : { data }),
});

export const fail = (content: string): PluginToolResult => ({ content, isError: true });

export function list<T>(
  items: T[] | null | undefined,
  render: (x: T) => string,
  empty: string,
): PluginToolResult {
  const rows = items ?? [];
  return {
    content: rows.length ? rows.map(render).join('\n') : empty,
    data: { rows },
  };
}

export function details(content: string, value: unknown): PluginToolResult {
  return { content, data: { details: value } };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

export function parseJson(value: unknown, fallback: unknown = {}): unknown {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  return JSON.parse(value);
}

export function quoteIdent(name: string): string {
  if (!name || /[\u0000-\u001f]/.test(name)) throw new Error('invalid SQL identifier');
  return `"${name.replace(/"/g, '""')}"`;
}

export async function resolveD1Database(
  ctx: PluginToolContext,
  database: string,
): Promise<D1DatabaseRef> {
  const dbs = await cfAcctPaged<D1DatabaseRef>(ctx, '/d1/database');
  const db = dbs.find((d) => d.name === database || d.uuid === database);
  if (db) return db;
  if (/^[0-9a-f-]{16,}$/i.test(database)) return { uuid: database, name: database };
  throw new Error(`database "${database}" not found`);
}

export async function d1Query(
  ctx: PluginToolContext,
  database: string,
  sql: string,
  params?: unknown[],
): Promise<D1QueryResult> {
  const db = await resolveD1Database(ctx, database);
  const payload = params?.length ? { sql, params } : { sql };
  const raw = await cfAcct<Array<{ results?: unknown[]; meta?: unknown }>>(
    ctx,
    `/d1/database/${db.uuid}/query`,
    { method: 'POST', body: JSON.stringify(payload) },
  );
  const first = Array.isArray(raw) ? raw[0] : raw;
  const rows = ((first?.results ?? []) as Array<Record<string, unknown>>).map((r) => asRecord(r));
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return { database: db, rows, columns, meta: first?.meta, raw };
}

function parseConfigName(text: string): string | null {
  const m =
    text.match(/"name"\s*:\s*"([^"]+)"/) ?? text.match(/^\s*name\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
}

export async function detectCloudflare(ctx: PluginToolContext): Promise<CfDetect> {
  const out: CfDetect = {
    isCloudflare: false,
    configPath: null,
    workerName: null,
    packageName: null,
    deployKind: null,
    openNextConfig: null,
  };
  if (!ctx.fs) return out;

  let hasPages = false;
  let hasOpenNextDep = false;
  let hasNext = false;

  for (const cfg of ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json']) {
    if (await ctx.fs.exists(cfg)) {
      out.isCloudflare = true;
      out.configPath = cfg;
      try {
        out.workerName = parseConfigName(await ctx.fs.readFile(cfg));
      } catch {
        /* ignore unreadable config */
      }
      break;
    }
  }

  // OpenNext config file at the root (any extension wrangler accepts for it).
  for (const cfg of ['open-next.config.ts', 'open-next.config.js', 'open-next.config.mjs']) {
    if (await ctx.fs.exists(cfg)) {
      out.openNextConfig = cfg;
      out.isCloudflare = true;
      break;
    }
  }

  if (await ctx.fs.exists('package.json')) {
    try {
      const pkg = JSON.parse(await ctx.fs.readFile('package.json')) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      out.packageName = pkg.name ?? null;
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.wrangler || deps['@cloudflare/workers-types']) out.isCloudflare = true;
      if (deps['@opennextjs/cloudflare']) {
        hasOpenNextDep = true;
        out.isCloudflare = true;
      }
      if (deps['@cloudflare/next-on-pages']) hasPages = true;
      if (deps.next) hasNext = true;
    } catch {
      /* ignore malformed package.json */
    }
  }

  // Classify the deploy model (most specific first).
  if (out.openNextConfig || hasOpenNextDep) out.deployKind = 'opennext';
  else if (hasPages || ((hasNext || out.isCloudflare) && !out.configPath && (await ctx.fs.exists('functions'))))
    out.deployKind = 'pages';
  else if (out.isCloudflare) out.deployKind = 'worker';

  return out;
}
