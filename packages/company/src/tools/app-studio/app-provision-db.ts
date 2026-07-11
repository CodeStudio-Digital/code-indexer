/**
 * Tool: `app_provision_db`. Aplica as migrations no banco LOCAL (D1 via
 * miniflare — o MESMO estado que o preview lê) e grava
 * `.app-studio/db.json`, que o gate da etapa database confere.
 *
 * Fronteira de segurança: esta tool é LOCAL-only. Criar o banco remoto na
 * conta Cloudflare do usuário é exclusivo da launch chain iniciada pelo
 * usuário no painel Publicar.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { AppToolBinding } from '@mcp/company/tools/app-studio/binding.js';
import { getAppStudioStore } from '@mcp/company/tools/app-studio/store-binding.js';
import {
  ensureAppStudioDbConnection,
  getAppStudioDbClientStore,
} from '@mcp/company/tools/app-studio/db-client-bridge.js';
import { resolveHostPath } from '@mcp/company/tools/design-system/ds-publish-version.js';
import { findLocalD1File } from '@mcp/app-studio/local-db.js';
import { getDatabaseProvisioner } from '@mcp/services/app-studio/index.js';

const PARAMETERS: JsonSchema = { type: 'object', properties: {} };

export function appProvisionDb(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_provision_db',
    description:
      'Apply the SQL migrations to the LOCAL database (the same one the live preview reads) and record the status the database-stage gate checks. Run after writing/altering migrations. Local only — publishing to the cloud happens from the Publicar panel.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async (_args, ctx) => {
      try {
        const store = getAppStudioStore();
        if (!store) return err('app_provision_db: AppStudioStore not wired.');
        const session = binding.resolveAppSession(store);
        if (!session) return err(`No AppStudioSession bound to ${binding.describeBinding()}.`);

        const resolved = resolveHostPath('.', ctx);
        if (resolved.kind === 'no-bind-mount') return err(resolved.message);

        let provisioner;
        try {
          provisioner = getDatabaseProvisioner(session.db_engine);
        } catch (e) {
          return err((e as Error).message);
        }
        const outcome = await provisioner.ensureLocal({
          workspaceDir: resolved.path,
          appSlug: session.app_slug,
          bindingName: 'DB',
        });
        if (!outcome.ok) {
          if (outcome.phase === 'seed') {
            return err(JSON.stringify({
              error: 'Local database example-data synchronization failed.',
              phase: 'seed',
              schema_ready: outcome.schemaReady ?? false,
              migrations_applied: outcome.applied,
              detail: outcome.error ?? 'unknown error',
              next: 'Call app_get_db_assets, fix the COMPLETE canonical seed with app_save_db_seed, then retry app_provision_db. Do not create another migration for this seed error.',
            }, null, 2));
          }
          return err(JSON.stringify({
            error: 'Local database migration failed.',
            phase: outcome.phase ?? 'migration',
            schema_ready: outcome.schemaReady ?? false,
            detail: outcome.error ?? 'unknown error',
            next: 'Inspect app_get_db_assets and the actual schema. Do not create another migration until the failed migration is understood.',
          }, null, 2));
        }
        const dbStore = getAppStudioDbClientStore();
        const dbFile = findLocalD1File(resolved.path);
        const registration =
          dbStore && dbFile
            ? ensureAppStudioDbConnection(dbStore, session, dbFile)
            : null;
        return ok(
          `Local database ready — ${outcome.applied.length > 0 ? `applied ${outcome.applied.length} pending migration(s): ${outcome.applied.join(', ')}` : 'no pending migrations were required'}, ` +
            'and synchronized seeds/seed.sql without reapplying an unchanged seed. ' +
            (registration
              ? `Registered native database connection '${registration.connection.label}' for db_list/db_schema/db_query/db_command. `
              : 'Native database connection registration was skipped because the local DB file/store was not available. ') +
            'Verify the example data shows in the preview before submitting the stage.',
        );
      } catch (e) {
        return err(`app_provision_db failed: ${(e as Error).message}`);
      }
    },
    repeatPolicy: 'volatile',
  };
}
