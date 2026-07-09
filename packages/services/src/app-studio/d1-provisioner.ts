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
import { listSqlMigrations, sqlHasStatements } from '@mcp/app-studio/pipeline/gate-checks.js';
import { readDbStatus, writeDbStatus } from '@mcp/app-studio/status-files.js';
import type {
  DatabaseProvisioner,
  ProvisionCtx,
  ProvisionOutcome,
} from '@mcp/app-studio/provisioner/types.js';
import { runHostCommand } from '../host-scaffold/run-host-command.js';
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

function fail(error: string): ProvisionOutcome {
  return { ok: false, applied: [], error };
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
    const run = await wrangler(ctx, ['d1', 'migrations', 'apply', ctx.bindingName, '--local'], LOCAL_TIMEOUT_MS);
    if (!run.ok) {
      return fail(`wrangler d1 migrations apply --local failed (exit ${run.exitCode}): ${run.stderrTail}`);
    }
    // Carrega os dados de exemplo (seeds/seed.sql) no MESMO estado local
    // que o preview lê — sem isso as telas e o painel "Seus dados" ficam
    // vazios apesar do agente ter escrito o seed.
    const seed = await execSeed(ctx, '--local');
    if (!seed.ok) return fail(seed.error ?? 'seed failed');
    writeDbStatus(ctx.workspaceDir, {
      engine: 'd1',
      local_ready: true,
      applied: migrations,
      seeded: seedHasContent(ctx),
      last_apply_at: new Date().toISOString(),
    });
    return { ok: true, applied: migrations };
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
