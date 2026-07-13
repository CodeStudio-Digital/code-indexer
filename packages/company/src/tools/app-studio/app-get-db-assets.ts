import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { err } from '@mcp/code-agent/core/tool.js';
import { appMigrationHazards } from '@mcp/app-studio/database/migration.js';
import { appSeedHash, validateAppSeedSql } from '@mcp/app-studio/database/seed.js';
import { listSqlMigrations } from '@mcp/app-studio/pipeline/gate-checks.js';
import { readDbStatus } from '@mcp/app-studio/status-files.js';
import { resolveHostPath } from '@mcp/company/tools/design-system/ds-publish-version.js';
import type { AppToolBinding } from './binding.js';
import { getAppStudioStore } from './store-binding.js';
import { markdownCode, renderStructuredMarkdown, structuredResult } from '@mcp/code-agent/core/model-output.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    migration: { type: 'string', description: 'Optional exact migration filename whose SQL should be returned.' },
    include_seed: { type: 'boolean', description: 'Return canonical seeds/seed.sql contents. Default: false; request only when editing seed data.' },
  },
  additionalProperties: false,
};

function readOptional(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

export function appGetDbAssets(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_get_db_assets',
    description: 'Inspect migration metadata, pending synchronization and the last provisioning phase. Seed or selected migration SQL is returned only when explicitly requested.',
    parameters: PARAMETERS,
    source: 'native',
    riskLevel: 'read',
    handler: async (args, ctx) => {
      try {
        const store = getAppStudioStore();
        if (!store) return err('app_get_db_assets: AppStudioStore not wired.');
        const session = binding.resolveAppSession(store);
        if (!session) return err(`No AppStudioSession bound to ${binding.describeBinding()}.`);
        const resolved = resolveHostPath('.', ctx);
        if (resolved.kind === 'no-bind-mount') return err(resolved.message);

        const migrations = listSqlMigrations(resolved.path);
        const status = readDbStatus(resolved.path);
        const pending = migrations.filter((name) => !status?.applied.includes(name));
        const requested = typeof args.migration === 'string' ? args.migration.trim() : '';
        if (requested && !migrations.includes(requested)) return err(`Migration '${requested}' not found.`);
        const seedSql = readOptional(join(resolved.path, 'seeds', 'seed.sql'));
        const seedHash = appSeedHash(resolved.path);
        const seedIssue = seedSql ? validateAppSeedSql(seedSql) : 'seeds/seed.sql is missing or empty.';
        const seedNeedsSync = !!seedHash && (!status?.seeded || status.seed_hash !== seedHash);
        const migrationDetails = migrations.map((name) => {
          const sql = readOptional(join(resolved.path, 'migrations', name)) ?? '';
          return { name, applied: status?.applied.includes(name) ?? false, hazards: appMigrationHazards(sql) };
        });

        let recommendedAction: string;
        if (status?.last_error_phase === 'seed' && seedHash && seedHash !== status.seed_hash && !seedIssue) {
          recommendedAction = 'The canonical seed was replaced after the failure. Retry app_provision_db; do not create a migration.';
        } else if (status?.last_error_phase === 'seed' || seedIssue) {
          recommendedAction = 'The failure is in canonical example data. Fix seeds/seed.sql with app_save_db_seed; do not create a schema migration.';
        } else if (pending.length > 0) {
          recommendedAction = 'Existing migration files are pending. Run app_provision_db; do not create another migration first.';
        } else if (status?.local_ready && !seedNeedsSync) {
          recommendedAction = 'Database assets are synchronized. Inspect the real schema/data with db_schema and read-only db_query; create a migration only for a confirmed spec/schema difference.';
        } else {
          recommendedAction = 'Inspect the real schema and approved spec before deciding whether a migration is needed.';
        }

        const selectedMigration = requested ? { name: requested, sql: readOptional(join(resolved.path, 'migrations', requested)) } : null;
        const includeSeed = args.include_seed === true;
        const data = {
          app_session_id: session.id,
          migrations: migrationDetails,
          pending_migrations: pending,
          selected_migration: selectedMigration,
          seed: {
            exists: seedSql != null,
            hash: seedHash,
            issue: seedIssue,
            needs_sync: seedNeedsSync,
            sql: includeSeed ? seedSql : undefined,
          },
          local_status: status,
          recommended_action: recommendedAction,
        };
        const summary = {
          ...data,
          selected_migration: selectedMigration ? { name: selectedMigration.name, sql_chars: selectedMigration.sql?.length ?? 0 } : null,
          seed: { ...data.seed, sql: undefined, sql_chars: includeSeed ? seedSql?.length ?? 0 : 0 },
        };
        const blocks = [renderStructuredMarkdown(summary, 'App database assets')];
        if (selectedMigration?.sql != null) blocks.push(`## Migration SQL — ${selectedMigration.name}\n\n${markdownCode(selectedMigration.sql, 'sql')}`);
        if (includeSeed && seedSql != null) blocks.push(`## Canonical seed SQL\n\n${markdownCode(seedSql, 'sql')}`);
        return structuredResult(data, blocks.join('\n\n'));
      } catch (e) {
        return err(`app_get_db_assets failed: ${(e as Error).message}`);
      }
    },
    repeatPolicy: 'volatile',
  };
}
