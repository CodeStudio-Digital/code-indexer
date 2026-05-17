/**
 * Tool: `ds_validate_stories`.
 *
 * Cross-check that every `argTypes` key, `args` key, and `argTypes.<k>.options`
 * literal in each `.stories.{ts,tsx,jsx,js}` file is also declared on the
 * sibling component's `Props` interface AND in the manifest's `props_schema`.
 *
 * This is the gate that would have blocked the "Button v1.2.2" incident
 * (Material UI vocabulary `contained|outlined|text` leaked into a manifest
 * whose CSS source was Bootstrap, breaking every story render). The master
 * MUST call this immediately after the components-builder Phase 2 finishes,
 * before the storybook-builder runs `npm run build-storybook`.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';
import {
  validateDesignSystemManifestData,
  type DesignSystemManifestV2,
} from '@mcp/design-system/manifest-schema.js';
import { validateStoryFidelity } from '@mcp/design-system/package-audit.js';
import { resolveHostPath } from '@mcp/company/tools/design-system/ds-publish-version.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    component_dir: {
      type: 'string',
      description:
        "Directory containing component sources and *.stories.{ts,tsx,jsx,js} files. Defaults to 'pkg/src'.",
    },
    manifest_path: {
      type: 'string',
      description:
        "Path to manifest.json. Defaults to walking upward from component_dir to find 'manifest.json'.",
    },
  },
};

function findManifestUpwards(startDir: string): string | null {
  let current = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(current, 'manifest.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function dsValidateStories(
  orchestrator: CompanyOrchestrator,
  agentRole: string,
  agentRunId: number | null,
): CoderTool {
  return {
    name: 'ds_validate_stories',
    description:
      "Validate every *.stories.{ts,tsx,jsx,js} file under component_dir against (a) the sibling component's Props interface and (b) manifest.json#components[].props_schema. Catches argTypes/args keys not on Props, argTypes/args keys not in manifest props_schema, and argTypes.<k>.options values that are not declared in props_schema.<k>.values. Master must call this immediately after Phase 2 (components-builder) and before Phase 5b (storybook build). Failures should trigger a single retry of components-builder with the exact mismatches.",
    parameters: PARAMETERS,
    source: 'native',
    handler: async (args, ctx) => {
      const componentDirArg = typeof args.component_dir === 'string' && args.component_dir.trim()
        ? args.component_dir.trim()
        : 'pkg/src';
      const resolvedDir = resolveHostPath(componentDirArg, ctx);
      if (resolvedDir.kind === 'no-bind-mount') return err(resolvedDir.message);
      if (!existsSync(resolvedDir.path)) {
        return err(`component_dir '${resolvedDir.path}' does not exist.`);
      }

      let manifestPath: string | null;
      if (typeof args.manifest_path === 'string' && args.manifest_path.trim()) {
        const resolvedManifest = resolveHostPath(args.manifest_path.trim(), ctx);
        if (resolvedManifest.kind === 'no-bind-mount') return err(resolvedManifest.message);
        manifestPath = resolvedManifest.path;
      } else {
        manifestPath = findManifestUpwards(resolvedDir.path);
      }

      let manifest: DesignSystemManifestV2 | null = null;
      if (manifestPath && existsSync(manifestPath)) {
        try {
          const raw = await readFile(manifestPath, 'utf8');
          const data = JSON.parse(raw);
          const parsed = validateDesignSystemManifestData(data, { strict: false });
          if (parsed.ok && parsed.manifest) manifest = parsed.manifest;
          else return err(
            `manifest.json at ${manifestPath} failed schema validation. Run ds_validate_manifest first.\n` +
              parsed.errors.map((e) => `- ${e.path}: ${e.message}`).join('\n'),
          );
        } catch (e) {
          return err(`failed to read manifest at ${manifestPath}: ${(e as Error).message}`);
        }
      }

      void orchestrator; void agentRole; void agentRunId;

      const result = await validateStoryFidelity({ componentDir: resolvedDir.path, manifest });

      const lines: string[] = [];
      lines.push(`Stories scanned: ${result.storyCount}`);
      if (manifestPath) lines.push(`Manifest: ${manifestPath}`);
      else lines.push('Manifest: (none — skipping props_schema cross-check)');
      if (result.errors.length > 0) {
        lines.push('Errors:');
        for (const issue of result.errors) {
          lines.push(`- [${issue.code}] ${issue.file ?? '(no file)'}: ${issue.message}`);
        }
      }
      if (result.warnings.length > 0) {
        lines.push('Warnings:');
        for (const issue of result.warnings) {
          lines.push(`- [${issue.code}] ${issue.file ?? '(no file)'}: ${issue.message}`);
        }
      }
      if (result.errors.length === 0 && result.warnings.length === 0) {
        lines.push('All stories match Props and manifest props_schema.');
      }

      const formatted = lines.join('\n');
      if (!result.ok) return err(formatted);
      return ok(formatted);
    },
  };
}
