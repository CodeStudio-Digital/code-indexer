/**
 * Provisioner D1 do App Studio — implementação MVP do contrato
 * `DatabaseProvisioner` (@mcp/app-studio/provisioner/types).
 *
 *   - `ensureLocal`            → agent-callable (tool app_provision_db):
 *                                `wrangler d1 migrations apply DB --local`
 *                                (estado em .wrangler/state, o MESMO que o
 *                                vite dev server lê) + grava
 *                                .app-studio/db.json p/ o gate da etapa.
 *   - `provisionRemote`        → EXCLUSIVO da launch chain (conta CF do
 *                                usuário): `d1 create`, resolve o uuid via
 *                                `d1 list --json` (find por nome — robusto
 *                                a mudanças no texto do create) e escreve o
 *                                database_id no wrangler.jsonc.
 *   - `applyRemoteMigrations`  → `migrations apply DB --remote`.
 *
 * Todos os spawns via runHostCommand (resolve npx.cmd no win32, timeout,
 * abort, stream p/ onLog).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { listSqlMigrations, sqlHasStatements } from '@mcp/app-studio/pipeline/gate-checks.js';
import { appMigrationHazards } from '@mcp/app-studio/database/migration.js';
import { validateAppSeedSql } from '@mcp/app-studio/database/seed.js';
import { readDbStatus, writeDbStatus } from '@mcp/app-studio/status-files.js';
import type {
  DatabaseProvisioner,
  ProvisionCtx,
  ProvisionOutcome,
} from '@mcp/app-studio/provisioner/types.js';
import { runHostCommand } from '../host-scaffold/run-host-command.js';
import { parseLocalMigrationHistory } from './d1-migration-history.js';
import { currentDatabaseId, writeDatabaseId } from './wrangler-config.js';

const LOCAL_TIMEOUT_MS = 120_000;
const REMOTE_TIMEOUT_MS = 180_000;

interface WranglerRun {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderrTail: string;
}

async function wrangler(ctx: ProvisionCtx, args: string[], timeoutMs: number): Promise<WranglerRun> {
  let stdout = '';
  const result = await runHostCommand({
    program: 'npx',
    args: ['wrangler', ...args],
    cwd: ctx.workspaceDir,
    env: ctx.env,
    timeoutMs,
    signal: ctx.signal,
    onLog: (stream, chunk) => {
      if (stream === 'stdout') stdout += chunk;
      ctx.onLog?.(stream, chunk);
    },
  });
  return { ok: result.ok, exitCode: result.exitCode, stdout, stderrTail: result.stderrTail };
}

export async function inspectLocalD1MigrationHistory(ctx: ProvisionCtx): Promise<string[] | null> {
  const run = await wrangler({ ...ctx, onLog: undefined }, [
    'd1',
    'execute',
    ctx.bindingName,
    '--local',
    '--command',
    // No spaces: runHostCommand uses the Windows .cmd shell for npx, whose
    // argument forwarding would otherwise split this SQL into CLI arguments.
    'SELECT(name)FROM(d1_migrations)ORDER/**/BY(id)',
    '--json',
  ], LOCAL_TIMEOUT_MS);
  if (!run.ok) return null;
  return parseLocalMigrationHistory(run.stdout);
}

function fail(error: string, extra: Partial<ProvisionOutcome> = {}): ProvisionOutcome {
  return { ok: false, applied: [], error, ...extra };
}

const SEED_REL = join('seeds', 'seed.sql');

/** seeds/seed.sql tem INSERTs reais (não só comentários/branco)? */
function seedHasContent(ctx: ProvisionCtx): boolean {
  const path = join(ctx.workspaceDir, SEED_REL);
  if (!existsSync(path)) return false;
  try {
    return sqlHasStatements(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
}

function seedHash(ctx: ProvisionCtx): string | null {
  const path = join(ctx.workspaceDir, SEED_REL);
  if (!existsSync(path)) return null;
  try {
    const contents = readFileSync(path, 'utf8');
    return sqlHasStatements(contents) ? createHash('sha256').update(contents).digest('hex') : null;
  } catch {
    return null;
  }
}

function seedValidationIssue(ctx: ProvisionCtx): string | null {
  const path = join(ctx.workspaceDir, SEED_REL);
  if (!existsSync(path)) return 'seeds/seed.sql is missing.';
  try {
    return validateAppSeedSql(readFileSync(path, 'utf8'));
  } catch (e) {
    return `could not read seeds/seed.sql: ${(e as Error).message}`;
  }
}

function pendingMigrationHazards(ctx: ProvisionCtx, pending: string[]): Array<{ migration: string; hazards: string[] }> {
  const out: Array<{ migration: string; hazards: string[] }> = [];
  for (const migration of pending) {
    try {
      const hazards = appMigrationHazards(readFileSync(join(ctx.workspaceDir, 'migrations', migration), 'utf8'));
      if (hazards.length > 0) out.push({ migration, hazards });
    } catch (e) {
      out.push({ migration, hazards: [`could not read migration: ${(e as Error).message}`] });
    }
  }
  return out;
}

/** Carrega seeds/seed.sql via `wrangler d1 execute` (local ou remote). */
async function execSeed(ctx: ProvisionCtx, scope: '--local' | '--remote'): Promise<{ ok: boolean; error?: string }> {
  if (!seedHasContent(ctx)) return { ok: true }; // sem dados de exemplo → nada a carregar
  const timeout = scope === '--remote' ? REMOTE_TIMEOUT_MS : LOCAL_TIMEOUT_MS;
  const run = await wrangler(ctx, ['d1', 'execute', ctx.bindingName, scope, '--file', SEED_REL], timeout);
  if (!run.ok) return { ok: false, error: `wrangler d1 execute ${scope} seed failed (exit ${run.exitCode}): ${run.stderrTail}` };
  return { ok: true };
}

export const d1Provisioner: DatabaseProvisioner = {
  engine: 'd1',

  async ensureLocal(ctx: ProvisionCtx): Promise<ProvisionOutcome> {
    const migrations = listSqlMigrations(ctx.workspaceDir);
    if (migrations.length === 0) {
      return fail('migrations/ has no .sql files — write the migrations before provisioning.');
    }
    const persisted = readDbStatus(ctx.workspaceDir);
    // Older versions wrote db.json only after seed success. Reconcile that
    // sidecar with Wrangler's real migration ledger before deciding that a
    // schema migration is pending or needs to be recreated.
    const actualApplied = await inspectLocalD1MigrationHistory(ctx);
    const previous = actualApplied === null
      ? persisted
      : {
          engine: 'd1' as const,
          local_ready: actualApplied.length > 0,
          applied: actualApplied,
          seeded: persisted?.seeded ?? false,
          seed_hash: persisted?.seed_hash ?? null,
          last_error_phase: persisted?.last_error_phase ?? null,
          last_error: persisted?.last_error ?? null,
          last_apply_at: persisted?.last_apply_at ?? new Date().toISOString(),
        };
    const pendingBefore = migrations.filter((name) => !previous?.applied.includes(name));
    const seedIssue = seedValidationIssue(ctx);
    if (seedIssue) {
      const error = `Canonical seed preflight failed before migrations were touched: ${seedIssue}`;
      writeDbStatus(ctx.workspaceDir, {
        engine: 'd1',
        local_ready: previous?.local_ready ?? false,
        applied: previous?.applied ?? [],
        seeded: false,
        seed_hash: previous?.seed_hash ?? null,
        last_error_phase: 'seed',
        last_error: error,
        last_apply_at: new Date().toISOString(),
      });
      return fail(error, { phase: 'seed', schemaReady: previous?.local_ready ?? false });
    }
    const hazardousPending = pendingMigrationHazards(ctx, pendingBefore);
    if (hazardousPending.length > 0) {
      const detail = hazardousPending.map((item) => `${item.migration}: ${item.hazards.join(', ')}`).join('; ');
      const error = `Pending destructive migrations were refused before execution: ${detail}`;
      writeDbStatus(ctx.workspaceDir, {
        engine: 'd1',
        local_ready: previous?.local_ready ?? false,
        applied: previous?.applied ?? [],
        seeded: previous?.seeded ?? false,
        seed_hash: previous?.seed_hash ?? null,
        last_error_phase: 'migration',
        last_error: error,
        last_apply_at: new Date().toISOString(),
      });
      return fail(error, { phase: 'migration', schemaReady: false });
    }
    const run = await wrangler(ctx, ['d1', 'migrations', 'apply', ctx.bindingName, '--local'], LOCAL_TIMEOUT_MS);
    if (!run.ok) {
      const error = `wrangler d1 migrations apply --local failed (exit ${run.exitCode}): ${run.stderrTail}`;
      writeDbStatus(ctx.workspaceDir, {
        engine: 'd1',
        local_ready: previous?.local_ready ?? false,
        applied: previous?.applied ?? [],
        seeded: previous?.seeded ?? false,
        seed_hash: previous?.seed_hash ?? null,
        last_error_phase: 'migration',
        last_error: error,
        last_apply_at: new Date().toISOString(),
      });
      return fail(error, { phase: 'migration', schemaReady: false });
    }
    // Carrega os dados de exemplo (seeds/seed.sql) no MESMO estado local
    // que o preview lê — sem isso as telas e o painel "Seus dados" ficam
    // vazios apesar do agente ter escrito o seed.
    const currentSeedHash = seedHash(ctx);
    const seedAlreadyLoaded = !!currentSeedHash && previous?.seeded === true && (
      previous.seed_hash === currentSeedHash || previous.seed_hash == null
    );
    const statusBase = {
      engine: 'd1' as const,
      local_ready: true,
      applied: migrations,
      seeded: seedAlreadyLoaded,
      seed_hash: currentSeedHash,
      last_error_phase: null,
      last_error: null,
      last_apply_at: new Date().toISOString(),
    };
    // Persist schema success before loading examples. A seed failure must not
    // make the next agent believe migrations are still pending.
    writeDbStatus(ctx.workspaceDir, statusBase);
    if (!seedAlreadyLoaded) {
      const seed = await execSeed(ctx, '--local');
      if (!seed.ok) {
        const error = seed.error ?? 'seed failed';
        writeDbStatus(ctx.workspaceDir, {
          ...statusBase,
          seeded: false,
          last_error_phase: 'seed',
          last_error: error,
          last_apply_at: new Date().toISOString(),
        });
        return fail(error, { applied: pendingBefore, phase: 'seed', schemaReady: true });
      }
    }
    writeDbStatus(ctx.workspaceDir, {
      ...statusBase,
      seeded: seedHasContent(ctx),
      last_error_phase: null,
      last_error: null,
      last_apply_at: new Date().toISOString(),
    });
    return { ok: true, applied: pendingBefore, schemaReady: true };
  },

  async provisionRemote(ctx: ProvisionCtx): Promise<{ databaseId: string; created: boolean }> {
    // Idempotente: id real já escrito → reuso (não semeia de novo).
    const existing = currentDatabaseId(ctx.workspaceDir);
    if (existing) return { databaseId: existing, created: false };

    const dbName = `${ctx.appSlug}-db`;
    const create = await wrangler(ctx, ['d1', 'create', dbName], REMOTE_TIMEOUT_MS);
    // "already exists" é aceitável (retry de launch) — o list resolve o id.
    // created = criamos AGORA (create.ok); "already exists" → banco pré-
    // existente, não semear de novo (pode já ter dados reais do usuário).
    if (!create.ok && !/already exists/i.test(create.stdout + create.stderrTail)) {
      throw new Error(`wrangler d1 create failed (exit ${create.exitCode}): ${create.stderrTail}`);
    }
    const created = create.ok;

    const list = await wrangler(ctx, ['d1', 'list', '--json'], REMOTE_TIMEOUT_MS);
    if (!list.ok) {
      throw new Error(`wrangler d1 list failed (exit ${list.exitCode}): ${list.stderrTail}`);
    }
    let databases: Array<{ name?: string; uuid?: string }>;
    try {
      const jsonStart = list.stdout.indexOf('[');
      databases = JSON.parse(list.stdout.slice(jsonStart)) as Array<{ name?: string; uuid?: string }>;
    } catch (e) {
      throw new Error(`Could not parse \`d1 list --json\` output: ${(e as Error).message}`);
    }
    const match = databases.find((d) => d.name === dbName);
    if (!match?.uuid) {
      throw new Error(`Database '${dbName}' not found in the account after create — check wrangler auth.`);
    }

    writeDatabaseId(ctx.workspaceDir, match.uuid);
    return { databaseId: match.uuid, created };
  },

  async applyRemoteMigrations(ctx: ProvisionCtx): Promise<ProvisionOutcome> {
    const migrations = listSqlMigrations(ctx.workspaceDir);
    const run = await wrangler(ctx, ['d1', 'migrations', 'apply', ctx.bindingName, '--remote'], REMOTE_TIMEOUT_MS);
    if (!run.ok) {
      return fail(`wrangler d1 migrations apply --remote failed (exit ${run.exitCode}): ${run.stderrTail}`);
    }
    return { ok: true, applied: migrations };
  },

  async applyRemoteSeed(ctx: ProvisionCtx): Promise<ProvisionOutcome> {
    const seed = await execSeed(ctx, '--remote');
    if (!seed.ok) return fail(seed.error ?? 'remote seed failed');
    return { ok: true, applied: [] };
  },

  async status(ctx: ProvisionCtx) {
    return readDbStatus(ctx.workspaceDir);
  },
};
