/**
 * REST routes for the session-scoped Databases tab.
 *
 * Contract:
 *   GET    /api/company/sessions/:id/databases        list with env key map
 *   POST   /api/company/sessions/:id/databases        create (envs included)
 *   PUT    /api/company/sessions/:id/databases/:dbId  edit (values, label, metadata)
 *   POST   /api/company/sessions/:id/databases/:dbId/promote   make primary
 *   DELETE /api/company/sessions/:id/databases/:dbId?also_delete_envs=1   remove
 *
 * All mutations run inside a single SQLite transaction (via
 * `mutateAndSync`) so the database row and its env rows cannot diverge.
 * Post-commit, the helper broadcasts the new env set to live containers
 * so running dev servers pick up DATABASE_URL edits without restart.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound, resolveRootSessionId } from '../_helpers.js';
import { getSandboxManager } from '@mcp/services/sandbox/index.js';
import {
  PROVIDERS,
  computeEnvKeys,
  isKnownProvider,
} from '@mcp/company/database-providers.js';
import type {
  DatabaseProvider,
  EnvKeyMap,
} from '@mcp/company/database-types.js';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LABEL_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

interface CreateBody {
  label?: string;
  provider?: string;
  values?: Record<string, string>;
  metadata?: Record<string, string>;
  /** Optional per-field env key override (defaults to primary/suffix rule). */
  env_keys?: EnvKeyMap;
}

interface UpdateBody {
  label?: string;
  values?: Record<string, string>;
  metadata?: Record<string, string>;
  env_keys?: EnvKeyMap;
}

export function mountCompanyDatabaseRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore, companySessionDatabaseStore, companySessionEnvStore } = deps;

  // ─── Shared helpers ──────────────────────────────────────────

  /**
   * Run `fn` inside a transaction, then broadcast env changes to live
   * containers. Error during the DB phase aborts cleanly; error during
   * the best-effort sync is swallowed (truthful state is always the DB).
   */
  async function mutateAndSync<T>(sessionId: number, fn: () => T): Promise<T> {
    const result = companySessionDatabaseStore.transaction(fn);
    await getSandboxManager()
      .syncEnvsToAllContainers(String(sessionId))
      .catch(() => void 0);
    return result;
  }

  function maskValue(value: string, secret: boolean, reveal: boolean): string {
    if (!secret) return value;
    return reveal ? value : '';
  }

  function serializeDatabase(
    db: ReturnType<typeof companySessionDatabaseStore.list>[number],
    reveal: boolean,
  ) {
    const spec = PROVIDERS[db.provider];
    const envValues: Record<string, { key: string; value: string; is_secret: boolean; masked: boolean }> = {};
    for (const field of spec.fields) {
      const envKey = db.env_keys[field.name];
      if (!envKey) continue;
      const envRow = companySessionEnvStore.get(db.session_id, envKey);
      envValues[field.name] = {
        key: envKey,
        value: envRow ? maskValue(envRow.value, field.secret, reveal) : '',
        is_secret: field.secret,
        masked: field.secret && !reveal,
      };
    }
    return {
      id: db.id,
      label: db.label,
      provider: db.provider,
      is_primary: db.is_primary,
      env_keys: db.env_keys,
      env_values: envValues,
      metadata: db.metadata,
      created_at: db.created_at,
      updated_at: db.updated_at,
    };
  }

  function validateProviderValues(
    provider: DatabaseProvider,
    values: Record<string, string>,
  ): string | null {
    const spec = PROVIDERS[provider];
    for (const field of spec.fields) {
      const v = values[field.name];
      if (typeof v !== 'string' || v.length === 0) {
        return `Missing value for field '${field.name}'`;
      }
    }
    return null;
  }

  function validateEnvKeysMap(map: EnvKeyMap | undefined): string | null {
    if (!map) return null;
    for (const [field, key] of Object.entries(map)) {
      if (!KEY_RE.test(key)) return `env_keys['${field}']: invalid key '${key}'`;
    }
    return null;
  }

  /**
   * Apply env key writes for a DB row. Deletes stale keys (if renaming)
   * and upserts the current ones with `is_secret` + `source: 'auto'`
   * — DB-managed envs are owned by their database row, not by the
   * operator. The Env tab badges these as `auto` so the source is
   * obvious, and the DELETE handler below removes them along with the
   * database row by default.
   */
  function writeEnvs(
    sessionId: number,
    envKeys: EnvKeyMap,
    values: Record<string, string>,
    provider: DatabaseProvider,
    staleKeysToDelete: string[] = [],
  ): void {
    const spec = PROVIDERS[provider];
    for (const staleKey of staleKeysToDelete) {
      companySessionEnvStore.delete(sessionId, staleKey);
    }
    for (const field of spec.fields) {
      const envKey = envKeys[field.name];
      if (!envKey) continue;
      const raw = values[field.name];
      if (typeof raw !== 'string') continue;
      companySessionEnvStore.upsert(sessionId, envKey, raw, field.secret, {
        source: 'auto',
      });
    }
  }

  /**
   * Delete env rows that this DB owned (for DELETE with also_delete_envs).
   */
  function deleteOwnedEnvs(sessionId: number, envKeys: EnvKeyMap): void {
    for (const key of Object.values(envKeys)) {
      companySessionEnvStore.delete(sessionId, key);
    }
  }

  // ─── GET list ────────────────────────────────────────────────

  app.get('/api/company/sessions/:id/databases', (c) => {
    const id = resolveRootSessionId(deps.companyStore, parseIdParam(c));
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    const reveal = c.req.query('reveal') === '1';
    const dbs = companySessionDatabaseStore.list(id);
    return c.json({
      databases: dbs.map((d) => serializeDatabase(d, reveal)),
      providers: PROVIDERS,
    });
  });

  // ─── POST create ─────────────────────────────────────────────

  app.post('/api/company/sessions/:id/databases', async (c) => {
    const id = resolveRootSessionId(deps.companyStore, parseIdParam(c));
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    const body = await parseJsonBody<CreateBody>(c);
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const provider = typeof body.provider === 'string' ? body.provider : '';
    if (!LABEL_RE.test(label)) {
      return c.json(
        {
          error:
            'Invalid label. Use 1-32 chars starting with a letter; letters/digits/underscore/dash only.',
        },
        400,
      );
    }
    if (!isKnownProvider(provider)) {
      return c.json({ error: `Unknown provider '${provider}'` }, 400);
    }
    const values = body.values ?? {};
    const validationErr = validateProviderValues(provider, values);
    if (validationErr) return c.json({ error: validationErr }, 400);
    const envKeysErr = validateEnvKeysMap(body.env_keys);
    if (envKeysErr) return c.json({ error: envKeysErr }, 400);

    // Unique label per session is enforced by the DB index, but a friendly 400 is
    // better UX than a raw constraint error.
    if (companySessionDatabaseStore.getByLabel(id, label)) {
      return c.json({ error: `A database with label '${label}' already exists.` }, 409);
    }

    // First of this provider → becomes primary (unprefixed env names).
    const isPrimary = companySessionDatabaseStore.findPrimary(id, provider) === null;
    const envKeys = computeEnvKeys(provider, label, isPrimary, body.env_keys);

    try {
      const created = await mutateAndSync(id, () => {
        const row = companySessionDatabaseStore.insert({
          session_id: id,
          label,
          provider,
          is_primary: isPrimary,
          env_keys: envKeys,
          metadata: body.metadata ?? {},
        });
        writeEnvs(id, envKeys, values, provider);
        return row;
      });
      return c.json({ database: serializeDatabase(created, false) });
    } catch (e) {
      return c.json({ error: errorMessage(e) }, 400);
    }
  });

  // ─── PUT edit ────────────────────────────────────────────────

  app.put('/api/company/sessions/:id/databases/:dbId', async (c) => {
    const id = resolveRootSessionId(deps.companyStore, parseIdParam(c));
    const dbId = parseIdParam(c, 'dbId');
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    const current = companySessionDatabaseStore.get(dbId);
    if (!current || current.session_id !== id) return notFound(c);
    const body = await parseJsonBody<UpdateBody>(c);

    const nextLabel =
      typeof body.label === 'string' && body.label.trim() ? body.label.trim() : current.label;
    if (!LABEL_RE.test(nextLabel)) {
      return c.json({ error: 'Invalid label.' }, 400);
    }
    if (nextLabel !== current.label) {
      const conflict = companySessionDatabaseStore.getByLabel(id, nextLabel);
      if (conflict && conflict.id !== current.id) {
        return c.json({ error: `label '${nextLabel}' already used.` }, 409);
      }
    }
    const envKeysErr = validateEnvKeysMap(body.env_keys);
    if (envKeysErr) return c.json({ error: envKeysErr }, 400);

    // If label changed (and not primary) we recompute suffixed env keys,
    // unless an explicit env_keys override is provided. Primary rows never
    // rename their envs via label change — user can override explicitly.
    const nextEnvKeys: EnvKeyMap =
      body.env_keys ??
      (nextLabel !== current.label && !current.is_primary
        ? computeEnvKeys(current.provider, nextLabel, false)
        : current.env_keys);

    const renamedKeys = diffEnvKeyRename(current.env_keys, nextEnvKeys);

    try {
      const updated = await mutateAndSync(id, () => {
        // 1. Migrate env rows for renamed keys (preserve existing values
        //    when caller does not pass new values).
        for (const { from, to } of renamedKeys) {
          const oldRow = companySessionEnvStore.get(id, from);
          if (oldRow) {
            companySessionEnvStore.upsert(id, to, oldRow.value, oldRow.is_secret === 1, {
              source: oldRow.source ?? 'user',
            });
            companySessionEnvStore.delete(id, from);
          }
        }
        // 2. Apply any fresh values provided.
        if (body.values) {
          writeEnvs(id, nextEnvKeys, body.values, current.provider);
        }
        // 3. Update the DB row.
        return companySessionDatabaseStore.update(current.id, {
          label: nextLabel,
          env_keys: nextEnvKeys,
          metadata: body.metadata,
        });
      });
      return c.json({ database: serializeDatabase(updated, false) });
    } catch (e) {
      return c.json({ error: errorMessage(e) }, 400);
    }
  });

  // ─── POST promote ────────────────────────────────────────────

  app.post('/api/company/sessions/:id/databases/:dbId/promote', async (c) => {
    const id = resolveRootSessionId(deps.companyStore, parseIdParam(c));
    const dbId = parseIdParam(c, 'dbId');
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    const target = companySessionDatabaseStore.get(dbId);
    if (!target || target.session_id !== id) return notFound(c);
    if (target.is_primary) return c.json({ database: serializeDatabase(target, false) });

    const currentPrimary = companySessionDatabaseStore.findPrimary(id, target.provider);

    try {
      const promoted = await mutateAndSync(id, () => {
        // Demote the current primary first (if any) — must run before
        // the promote to avoid violating the partial unique index.
        if (currentPrimary) {
          const demotedKeys = computeEnvKeys(
            currentPrimary.provider,
            currentPrimary.label,
            false,
          );
          migrateEnvs(id, currentPrimary.env_keys, demotedKeys);
          companySessionDatabaseStore.update(currentPrimary.id, {
            is_primary: false,
            env_keys: demotedKeys,
          });
        }
        // Now promote target.
        const promotedKeys = computeEnvKeys(target.provider, target.label, true);
        migrateEnvs(id, target.env_keys, promotedKeys);
        return companySessionDatabaseStore.update(target.id, {
          is_primary: true,
          env_keys: promotedKeys,
        });
      });
      return c.json({ database: serializeDatabase(promoted, false) });
    } catch (e) {
      return c.json({ error: errorMessage(e) }, 400);
    }
  });

  /** Helper: move envs from `from` key names to `to` key names, preserving values. */
  function migrateEnvs(sessionId: number, from: EnvKeyMap, to: EnvKeyMap): void {
    for (const [field, toKey] of Object.entries(to)) {
      const fromKey = from[field];
      if (!fromKey || fromKey === toKey) continue;
      const row = companySessionEnvStore.get(sessionId, fromKey);
      if (!row) continue;
      companySessionEnvStore.upsert(sessionId, toKey, row.value, row.is_secret === 1, {
        source: row.source ?? 'user',
      });
      companySessionEnvStore.delete(sessionId, fromKey);
    }
  }

  // ─── DELETE ──────────────────────────────────────────────────

  app.delete('/api/company/sessions/:id/databases/:dbId', async (c) => {
    const id = resolveRootSessionId(deps.companyStore, parseIdParam(c));
    const dbId = parseIdParam(c, 'dbId');
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    const current = companySessionDatabaseStore.get(dbId);
    if (!current || current.session_id !== id) return notFound(c);
    // Phase 5: also-delete-envs is now the DEFAULT. DB-managed envs are
    // tagged `source: 'auto'` and owned by the database row — leaving
    // them behind after a delete creates orphan envs that the operator
    // has to clean up manually (the root cause of "PREVIEW_URL_api
    // still there after I removed the api service"). Pass
    // `?keep_envs=1` to opt out (e.g., when migrating a DB connection
    // to a different provider without losing the value temporarily).
    const keepEnvs = c.req.query('keep_envs') === '1';
    const alsoDeleteEnvs = !keepEnvs;
    try {
      await mutateAndSync(id, () => {
        if (alsoDeleteEnvs) deleteOwnedEnvs(id, current.env_keys);
        companySessionDatabaseStore.delete(current.id);
      });
      return c.json({ ok: true, deleted_envs: alsoDeleteEnvs });
    } catch (e) {
      return c.json({ error: errorMessage(e) }, 400);
    }
  });
}

// ─── Helpers (file-local) ────────────────────────────────────────

function diffEnvKeyRename(
  from: EnvKeyMap,
  to: EnvKeyMap,
): Array<{ field: string; from: string; to: string }> {
  const renames: Array<{ field: string; from: string; to: string }> = [];
  for (const [field, toKey] of Object.entries(to)) {
    const fromKey = from[field];
    if (fromKey && fromKey !== toKey) renames.push({ field, from: fromKey, to: toKey });
  }
  return renames;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
