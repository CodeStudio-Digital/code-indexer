/**
 * Tool: `ds_audit_package`.
 *
 * Runs deterministic pre-publish checks over the generated package. It catches
 * missing MCP/Storybook artifacts and Storybook prop drift before
 * `ds_publish_version` can publish a broken tarball.
 */
import type { CoderTool, JsonSchema } from '../../../core/tool.js';
import { ok, err } from '../../../core/tool.js';
import type { CompanyOrchestrator } from '../../../company/orchestrator.js';
import { auditDesignSystemPackage, formatPackageAudit } from '../../../../../core/design-system/package-audit.js';
import { resolveHostPath } from './ds-publish-version.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    pkg_dir: {
      type: 'string',
      description: 'Path to the generated package directory. Defaults to pkg.',
    },
  },
};

export function dsAuditPackage(
  orchestrator: CompanyOrchestrator,
  agentRole: string,
  agentRunId: number | null,
): CoderTool {
  return {
    name: 'ds_audit_package',
    description:
      'Audit the generated Design System package before publish: manifest v2, package.json files/bin/exports, MCP manifest, Storybook static output, docs, and React stories props.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async (args, ctx) => {
      const pkgArg = typeof args.pkg_dir === 'string' && args.pkg_dir.trim()
        ? args.pkg_dir.trim()
        : 'pkg';
      const resolved = resolveHostPath(pkgArg, ctx);
      if (resolved.kind === 'no-bind-mount') return err(resolved.message);

      const result = await auditDesignSystemPackage(resolved.path);
      void orchestrator; void agentRole; void agentRunId;
      const formatted = formatPackageAudit(result);
      if (!result.ok) return err(formatted);
      return ok(formatted);
    },
  };
}
