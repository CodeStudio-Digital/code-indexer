/**
 * Tool: `ds_audit_package`.
 *
 * Runs deterministic pre-publish checks over the generated package. It catches
 * missing MCP/Storybook artifacts and Storybook prop drift before
 * `ds_publish_version` can publish a broken tarball.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { DsToolBinding } from '@mcp/company/tools/design-system/binding.js';
import { auditDesignSystemPackage, formatPackageAudit } from '@mcp/design-system/package-audit.js';
import { resolveHostPath } from '@mcp/company/tools/design-system/ds-publish-version.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    pkg_dir: {
      type: 'string',
      description: 'Path to the generated package directory. Defaults to pkg.',
    },
  },
};

export function dsAuditPackage(binding: DsToolBinding): CoderTool {
  return {
    name: 'ds_audit_package',
    description:
      'Audit the generated Design System package before publish: package.json files/exports/peerDependencies, docs, and stack artefacts. Run it before ds_publish_version and fix every error it reports.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async (args, ctx) => {
      const pkgArg = typeof args.pkg_dir === 'string' && args.pkg_dir.trim()
        ? args.pkg_dir.trim()
        : 'pkg';
      const resolved = resolveHostPath(pkgArg, ctx);
      if (resolved.kind === 'no-bind-mount') return err(resolved.message);

      const result = await auditDesignSystemPackage(resolved.path, { profile: binding.profile });
      const formatted = formatPackageAudit(result);
      if (!result.ok) return err(formatted);
      return ok(formatted);
    },
  };
}
