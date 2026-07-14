/**
 * Tool: `app_provision_db`. Aplica as migrations no banco LOCAL (D1 via
 * miniflare — o MESMO estado que o preview lê) e grava
 * `.app-studio/db.json`, usado como evidência verificável do card de dados.
 *
 * Fronteira de segurança: esta tool é LOCAL-only. Criar o banco remoto na
 * conta Cloudflare do usuário é exclusivo da launch chain iniciada pelo
 * usuário no painel Publicar.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { errStructured } from '@mcp/code-agent/core/model-output.js';
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
      'Apply SQL migrations to the LOCAL database used by the live preview and record verifiable database evidence. Run after writing or changing migrations. Local only — publishing to the cloud remains an explicit action in the Publish panel.',
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
            return errStructured({
              error: 'Local database example-data synchronization failed.',
              phase: 'seed',
              schema_ready: outcome.schemaReady ?? false,
              migrations_applied: outcome.applied,
              detail: outcome.error ?? 'unknown error',
              next: 'Call app_get_db_assets, fix the COMPLETE canonical seed with app_save_db_seed, then retry app_provision_db. Do not create another migration for this seed error.',
            });
          }
          return errStructured({
            error: 'Local database migration failed.',
            phase: outcome.phase ?? 'migration',
            schema_ready: outcome.schemaReady ?? false,
            detail: outcome.error ?? 'unknown error',
            next: 'Inspect app_get_db_assets and the actual schema. Do not create another migration until the failed migration is understood.',
          });
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
            'Verify the example data in the preview and record the result as card evidence.',
        );
      } catch (e) {
        return err(`app_provision_db failed: ${(e as Error).message}`);
      }
    },
    repeatPolicy: 'volatile',
  };
}
