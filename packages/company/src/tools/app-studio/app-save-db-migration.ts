import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { err, ok } from '@mcp/code-agent/core/tool.js';
import { currentStage, parsePipelineState } from '@mcp/app-studio/pipeline/stages.js';
import { listSqlMigrations } from '@mcp/app-studio/pipeline/gate-checks.js';
import { nextMigrationFilename, normalizeMigrationSlug, validateAppMigrationSql } from '@mcp/app-studio/database/migration.js';
import { resolveHostPath } from '@mcp/company/tools/design-system/ds-publish-version.js';
import type { AppToolBinding } from './binding.js';
import { getAppStudioStore } from './store-binding.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short migration name, e.g. add-club-owner-index.' },
    sql: { type: 'string', description: 'Complete D1/SQLite migration SQL. Multiple statements are allowed.' },
    seed_sql: {
      type: 'string',
      description: 'Optional idempotent example-data SQL. Use INSERT OR IGNORE or ON CONFLICT so local provisioning can be retried.',
    },
  },
  required: ['name', 'sql'],
  additionalProperties: false,
};

function normalizeSql(sql: string): string {
  return sql.trim().replace(/\r\n/g, '\n') + '\n';
}

function seedIsIdempotent(seedSql: string): boolean {
  return !/\bINSERT\b/i.test(seedSql) || /\bINSERT\s+OR\s+IGNORE\b|\bON\s+CONFLICT\b/i.test(seedSql);
}

export function appSaveDbMigration(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_save_db_migration',
    description:
      'Persist a NEW numbered D1/SQLite migration during the current database stage. Never edits an applied migration. Repeating identical SQL is idempotent. Optionally appends retry-safe example data to seeds/seed.sql. Call app_provision_db afterwards.',
    parameters: PARAMETERS,
    source: 'native',
    riskLevel: 'write',
    handler: async (args, ctx) => {
      try {
        const name = typeof args.name === 'string' ? args.name : '';
        const sql = typeof args.sql === 'string' ? args.sql : '';
        const slug = normalizeMigrationSlug(name);
        if (!slug) return err('name must contain letters or numbers, e.g. add-club-owner-index.');
        const sqlIssue = validateAppMigrationSql(sql);
        if (sqlIssue) return err(`app_save_db_migration: ${sqlIssue}`);
        const seedSql = typeof args.seed_sql === 'string' ? args.seed_sql.trim() : '';
        if (seedSql && !seedIsIdempotent(seedSql)) {
          return err('seed_sql contains INSERT but is not retry-safe. Use INSERT OR IGNORE or ON CONFLICT.');
        }

        const store = getAppStudioStore();
        if (!store) return err('app_save_db_migration: AppStudioStore not wired. Restart the API worker and retry once.');
        const session = binding.resolveAppSession(store);
        if (!session) return err(`No AppStudioSession bound to ${binding.describeBinding()}. Open the database specialist from App Studio.`);
        const state = parsePipelineState(session.pipeline_json);
        const current = state ? currentStage(state) : null;
        if (current?.id !== 'database') {
          return err(`Database migrations are locked while the current stage is '${current?.id ?? 'none'}'. Refine the spec/version first, then reopen or reach the database stage.`);
        }
        if (current.status === 'review') {
          return err("The database stage is awaiting user approval. Ask the user to reopen it before creating another migration.");
        }

        const resolved = resolveHostPath('.', ctx);
        if (resolved.kind === 'no-bind-mount') return err(resolved.message);
        const migrationsDir = join(resolved.path, 'migrations');
        mkdirSync(migrationsDir, { recursive: true });
        const normalized = normalizeSql(sql);
        const existing = listSqlMigrations(resolved.path);
        const duplicate = existing.find((filename) => (
          normalizeSql(readFileSync(join(migrationsDir, filename), 'utf8')) === normalized
        ));
        const filename = duplicate ?? nextMigrationFilename(existing, name);
        const created = !duplicate;
        if (created) writeFileSync(join(migrationsDir, filename), normalized, 'utf8');

        let seedUpdated = false;
        if (seedSql) {
          const seedDir = join(resolved.path, 'seeds');
          const seedPath = join(seedDir, 'seed.sql');
          mkdirSync(seedDir, { recursive: true });
          let currentSeed = '';
          try { currentSeed = readFileSync(seedPath, 'utf8'); } catch { /* new file */ }
          const marker = `-- app-studio:${filename}`;
          if (!currentSeed.includes(marker)) {
            writeFileSync(seedPath, `${currentSeed.trimEnd()}\n\n${marker}\n${normalizeSql(seedSql)}`, 'utf8');
            seedUpdated = true;
          }
        }

        return ok(JSON.stringify({
          migration: filename,
          created,
          seed_updated: seedUpdated,
          next: 'Call app_provision_db. Then call db_schema and a small db_query to verify the real local database before submitting the database stage.',
        }, null, 2));
      } catch (e) {
        return err(`app_save_db_migration failed: ${(e as Error).message}`);
      }
    },
  };
}
