/**
 * Tool: `ds_validate_manifest`.
 *
 * Validates the extractor's manifest against DesignSystemManifestV2 before
 * any builder agent is allowed to generate components. This turns shallow
 * manifests into actionable failures instead of letting bad contracts drift
 * into Storybook/MCP.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';
import { formatManifestValidation, validateDesignSystemManifestFile } from '@mcp/design-system/manifest-schema.js';
import { resolveHostPath } from '@mcp/company/tools/design-system/ds-publish-version.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    manifest_path: {
      type: 'string',
      description: 'Path to manifest.json, relative to project root or absolute. Defaults to manifest.json.',
    },
    strict: {
      type: 'boolean',
      description: 'When true (default), emit fidelity warnings in addition to schema errors.',
    },
    semantic: {
      type: 'boolean',
      description:
        "When true (default), cross-check manifest props_schema values, css_classes and tokens against the source-inventory shards (styles.json, dependencies.json). Detects vocab leaks (Material UI vocabulary in a Bootstrap source, etc.) and dangling classes. Pass false only when the inventory is unavailable.",
    },
    source_inventory_dir: {
      type: 'string',
      description:
        "Override the source-inventory shard directory. Defaults to '<dirname(manifest_path)>/source-inventory'.",
    },
  },
};

export function dsValidateManifest(
  orchestrator: CompanyOrchestrator,
  agentRole: string,
  agentRunId: number | null,
): CoderTool {
  return {
    name: 'ds_validate_manifest',
    description:
      'Validate a Design System extractor manifest against the v2 schema AND cross-check it against the source-inventory shards. Rejects shallow manifests, dangling classes, and props_schema values that do not exist in the source CSS (e.g. Material UI vocabulary leaked into a Bootstrap project). Call this after extractor finishes and before components-builder starts.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async (args, ctx) => {
      const manifestArg = typeof args.manifest_path === 'string' && args.manifest_path.trim()
        ? args.manifest_path.trim()
        : 'manifest.json';
      const resolved = resolveHostPath(manifestArg, ctx);
      if (resolved.kind === 'no-bind-mount') return err(resolved.message);

      const semanticEnabled = args.semantic !== false;
      let semanticOpts: { sourceInventoryDir?: string } | false = false;
      if (semanticEnabled) {
        if (typeof args.source_inventory_dir === 'string' && args.source_inventory_dir.trim()) {
          const resolvedShardDir = resolveHostPath(args.source_inventory_dir.trim(), ctx);
          if (resolvedShardDir.kind === 'no-bind-mount') return err(resolvedShardDir.message);
          semanticOpts = { sourceInventoryDir: resolvedShardDir.path };
        } else {
          semanticOpts = {};
        }
      }

      const result = await validateDesignSystemManifestFile(resolved.path, {
        strict: args.strict !== false,
        semantic: semanticOpts,
      });
      void orchestrator; void agentRole; void agentRunId;
      const summary = formatManifestValidation(result);
      if (!result.ok) return err(`Manifest validation failed for ${resolved.path}\n${summary}`);
      return ok(
        [
          `Manifest validation passed for ${resolved.path}.`,
          `Components: ${result.manifest?.components.length ?? 0}`,
          `Layouts: ${result.manifest?.layouts.length ?? 0}`,
          summary,
        ].join('\n'),
      );
    },
  };
}
