import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { err } from '@mcp/code-agent/core/tool.js';
import { currentStage, parsePipelineState } from '@mcp/app-studio/pipeline/stages.js';
import { listSqlMigrations } from '@mcp/app-studio/pipeline/gate-checks.js';
import { nextMigrationFilename, normalizeMigrationSlug, validateAppMigrationSql } from '@mcp/app-studio/database/migration.js';
import { replaceAppSeedFile, validateAppSeedSql } from '@mcp/app-studio/database/seed.js';
import { readDbStatus } from '@mcp/app-studio/status-files.js';
import { resolveHostPath } from '@mcp/company/tools/design-system/ds-publish-version.js';
import type { AppToolBinding } from './binding.js';
import { getAppStudioStore } from './store-binding.js';
import { appResult } from './model-output.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short migration name, e.g. add-club-owner-index.' },
    sql: { type: 'string', description: 'Complete D1/SQLite migration SQL. Multiple statements are allowed.' },
    seed_sql: {
      type: 'string',
      description: 'Optional COMPLETE canonical preview seed. It replaces seeds/seed.sql with a backup; every statement must use INSERT OR IGNORE or ON CONFLICT.',
    },
  },
  required: ['name', 'sql'],
  additionalProperties: false,
};

function normalizeSql(sql: string): string {
  return sql.trim().replace(/\r\n/g, '\n') + '\n';
}

export function appSaveDbMigration(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_save_db_migration',
    description:
      'Persist one NEW additive D1/SQLite schema migration during the current database stage. Destructive rebuilds are refused. Never edits an applied migration. Use app_save_db_seed when only example data changed.',
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
        const seedIssue = seedSql ? validateAppSeedSql(seedSql) : null;
        if (seedIssue) return err(`app_save_db_migration: ${seedIssue}`);

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
        const dbStatus = readDbStatus(resolved.path);
        if (dbStatus?.last_error_phase === 'seed') {
          return err(
            'The schema is already past the migration phase and the current failure is in seeds/seed.sql. ' +
              'Call app_get_db_assets, replace the canonical examples with app_save_db_seed, then retry app_provision_db. Do not create another migration for a seed error.',
          );
        }
        const migrationsDir = join(resolved.path, 'migrations');
        mkdirSync(migrationsDir, { recursive: true });
        const normalized = normalizeSql(sql);
        const existing = listSqlMigrations(resolved.path);
        const duplicate = existing.find((filename) => (
          normalizeSql(readFileSync(join(migrationsDir, filename), 'utf8')) === normalized
        ));
        const pending = existing.filter((filename) => !dbStatus?.applied.includes(filename));
        if (!duplicate && pending.length > 0) {
          return err(
            `Cannot create another migration while ${pending.length} existing migration(s) are pending: ${pending.join(', ')}. ` +
              'Inspect them with app_get_db_assets and resolve/provision that exact set first.',
          );
        }
        const filename = duplicate ?? nextMigrationFilename(existing, name);
        const created = !duplicate;
        if (created) writeFileSync(join(migrationsDir, filename), normalized, 'utf8');

        const seedResult = seedSql ? replaceAppSeedFile(resolved.path, seedSql) : null;

        return appResult('App database migration saved', {
          migration: filename,
          created,
          seed_replaced: seedResult?.changed ?? false,
          seed_backup: seedResult?.backup_path ?? null,
          next: 'Call app_provision_db. Then call db_schema and a small db_query to verify the real local database before submitting the database stage.',
        });
      } catch (e) {
        return err(`app_save_db_migration failed: ${(e as Error).message}`);
      }
    },
  };
}
