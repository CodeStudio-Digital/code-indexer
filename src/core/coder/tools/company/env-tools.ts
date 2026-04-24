/**
 * env_* tools — shared session env vars for builder agents.
 *
 * The sandbox pre-injects the current env set as container env vars
 * AND materializes `/app/.env` for live pickup. These tools let the
 * agent introspect and evolve that set from inside the sandbox loop:
 * typical usage is "I just scaffolded a service that needs DATABASE_URL;
 * env_set('DATABASE_URL', '…') so the frontend + backend share it."
 *
 * Only registered when `companyContext.sandbox` is present (same gate
 * as docs tools) — without a sandbox these tools have nothing to do.
 */

import type { CoderTool, ToolContext, ToolResult } from '../../core/tool.js';
import { ok, err } from '../../core/tool.js';
import type { CompanySessionEnvStore } from '../../../../store/company-session-env-store.js';
import { getSandboxManager } from '../../../sandbox/index.js';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Module-level binding. Wired from server.ts at boot — the agent tool
 * registry is created inside runCoder without direct access to
 * `ServerDeps`, so we use a setter mirror the sandbox store pattern.
 */
let envStore: CompanySessionEnvStore | null = null;
export function setEnvToolStore(store: CompanySessionEnvStore | null): void {
  envStore = store;
}
function store(): CompanySessionEnvStore | null {
  return envStore;
}

function sessionIdOf(ctx: ToolContext): number | null {
  const raw = ctx.companyContext?.companySessionId;
  if (raw === undefined || raw === null) return null;
  return typeof raw === 'number' ? raw : Number(raw);
}

const envList: CoderTool = {
  name: 'env_list',
  description:
    'List every shared env var defined for this session. Returns key + value pairs as a newline- ' +
    'separated table. Call this BEFORE writing code that reads process.env / c.env — you may find ' +
    'a variable already exists (DATABASE_URL, API_BASE_URL, etc.) and should be reused rather than ' +
    're-invented under a different name.',
  source: 'native',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx): Promise<ToolResult> => {
    const s = store();
    if (!s) return err('env tools unavailable (store not wired)');
    const sessionId = sessionIdOf(ctx);
    if (sessionId === null) return err('env_list requires a company session context');
    const rows = s.list(sessionId);
    if (rows.length === 0) return ok('(no env vars defined yet)');
    return ok(
      rows
        .map((r) => `${r.key}=${r.value}${r.is_secret ? ' # (secret)' : ''}`)
        .join('\n'),
    );
  },
};

const envRead: CoderTool = {
  name: 'env_read',
  description:
    'Read a single shared env var by key. Returns the raw value (secrets are NOT masked — agents ' +
    'need the real value to write correct config). Returns an error when the key does not exist; ' +
    'use env_list if you are unsure which keys are defined.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Variable name, e.g. DATABASE_URL' },
    },
    required: ['key'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const s = store();
    if (!s) return err('env tools unavailable');
    const sessionId = sessionIdOf(ctx);
    if (sessionId === null) return err('env_read requires a company session context');
    const key = String(args.key ?? '').trim();
    if (!KEY_RE.test(key)) return err(`env_read: invalid key '${key}'`);
    const row = s.get(sessionId, key);
    if (!row) return err(`env_read: '${key}' is not defined`);
    return ok(row.value);
  },
};

const envSet: CoderTool = {
  name: 'env_set',
  description:
    'Create or overwrite a shared env var. The new value is immediately persisted and pushed to ' +
    'every live container of the session as `/app/.env` (running dev-servers pick it up on their ' +
    'next file-watch tick; some frameworks require a restart to re-read env). Use `is_secret: true` ' +
    'for API keys / tokens — that masks the value in the dashboard Env tab (agents still see ' +
    'plaintext). Key MUST match /^[A-Za-z_][A-Za-z0-9_]*$/.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string' },
      value: { type: 'string' },
      is_secret: {
        type: 'boolean',
        description: 'Mark as secret so the dashboard masks the value.',
      },
    },
    required: ['key', 'value'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const s = store();
    if (!s) return err('env tools unavailable');
    const sessionId = sessionIdOf(ctx);
    if (sessionId === null) return err('env_set requires a company session context');
    const key = String(args.key ?? '').trim();
    if (!KEY_RE.test(key)) return err(`env_set: invalid key '${key}'`);
    const value = String(args.value ?? '');
    s.upsert(sessionId, key, value, !!args.is_secret, { source: 'agent' });
    await getSandboxManager()
      .syncEnvsToAllContainers(String(sessionId))
      .catch(() => void 0);
    return ok(`Set ${key} (${args.is_secret ? 'secret' : 'plain'}, ${value.length} bytes)`);
  },
};

const envValidate: CoderTool = {
  name: 'env_validate',
  description:
    'Check that every env var in `required` exists with a non-empty value for this session. Returns ' +
    '`ok` when all are present, or a list of missing/empty keys otherwise. Use this BEFORE starting ' +
    'a dev-server or running scaffolder commands that fail opaquely when config is missing (e.g. ' +
    'DATABASE_URL, API_BASE_URL, CLOUDFLARE_ACCOUNT_ID). Cheaper than reading each one via env_read.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      required: {
        type: 'array',
        items: { type: 'string' },
        description: 'Env var keys that MUST be defined and non-empty.',
      },
    },
    required: ['required'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const s = store();
    if (!s) return err('env tools unavailable');
    const sessionId = sessionIdOf(ctx);
    if (sessionId === null) return err('env_validate requires a company session context');
    const required = Array.isArray(args.required) ? (args.required as unknown[]) : [];
    if (required.length === 0) {
      return err('env_validate: pass a non-empty `required` array');
    }
    const present = s.asRecord(sessionId);
    const missing: string[] = [];
    const empty: string[] = [];
    for (const raw of required) {
      const key = String(raw ?? '').trim();
      if (!KEY_RE.test(key)) {
        return err(`env_validate: invalid key '${key}'`);
      }
      if (!(key in present)) {
        missing.push(key);
        continue;
      }
      if (present[key] === '') empty.push(key);
    }
    if (missing.length === 0 && empty.length === 0) {
      return ok(`All ${required.length} required env vars are set.`);
    }
    const parts: string[] = [];
    if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
    if (empty.length) parts.push(`empty: ${empty.join(', ')}`);
    return err(
      `env_validate failed — ${parts.join('; ')}. ` +
        `Set them with env_set before proceeding.`,
    );
  },
};

const envDelete: CoderTool = {
  name: 'env_delete',
  description:
    'Remove a shared env var. Both the DB row and the in-container `.env` entry go away; the ' +
    'next provision will not re-inject the key. Use when a service is removed or an env is ' +
    'renamed. Idempotent — deleting a non-existent key is a no-op.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: { key: { type: 'string' } },
    required: ['key'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const s = store();
    if (!s) return err('env tools unavailable');
    const sessionId = sessionIdOf(ctx);
    if (sessionId === null) return err('env_delete requires a company session context');
    const key = String(args.key ?? '').trim();
    if (!KEY_RE.test(key)) return err(`env_delete: invalid key '${key}'`);
    s.delete(sessionId, key);
    await getSandboxManager()
      .syncEnvsToAllContainers(String(sessionId))
      .catch(() => void 0);
    return ok(`Deleted ${key}`);
  },
};

export const envTools: CoderTool[] = [envList, envRead, envSet, envDelete, envValidate];
