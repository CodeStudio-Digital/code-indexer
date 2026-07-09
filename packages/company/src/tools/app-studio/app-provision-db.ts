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
import { resolveHostPath } from '@mcp/company/tools/design-system/ds-publish-version.js';
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
          return err(`Local database provisioning failed: ${outcome.error ?? 'unknown error'}`);
        }
        return ok(
          `Local database ready — applied ${outcome.applied.length} migration(s): ${outcome.applied.join(', ')}, ` +
            'and loaded seeds/seed.sql. Verify the example data shows in the preview before submitting the stage.',
        );
      } catch (e) {
        return err(`app_provision_db failed: ${(e as Error).message}`);
      }
    },
  };
}
