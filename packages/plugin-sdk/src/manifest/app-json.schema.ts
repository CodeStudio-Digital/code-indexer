/**
 * `.app.json` — the proprietary IDE-contribution manifest layered on top of
 * the Claude Code core. Declarative on purpose: the host reads contributions
 * (tool windows, commands, themes, agent-tool metadata) WITHOUT executing
 * plugin code. The matching handlers live in the bundled `worker` entry and
 * are keyed by `name`/`id`.
 */
import { z } from 'zod';
import { thirdPartyProviderSpecSchema, providerSpecSchema } from '@mcp/provider-sdk';
import { CONTRIB_ID_RE, relPath } from './common.js';

const contribId = z.string().regex(CONTRIB_ID_RE, 'id must be kebab/snake-case');

export const pluginToolDeclSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: z.record(z.unknown()).default({}),
  riskLevel: z.enum(['read', 'write', 'execute', 'admin']).optional(),
  mutates: z.boolean().optional(),
  activation: z.lazy(() => activationRuleSchema).optional(),
});

export const activationRuleSchema = z
  .object({
    whenFiles: z.array(z.string().min(1)).optional(),
    whenPackageDep: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const toolWindowDeclSchema = z.object({
  id: contribId,
  title: z.string().min(1),
  icon: z.string().optional(),
  side: z.enum(['left', 'right', 'bottom']),
  entry: relPath,
  activation: activationRuleSchema.optional(),
});

export const commandDeclSchema = z.object({
  id: contribId,
  label: z.string().min(1),
  category: z.string().optional(),
  shortcut: z.string().optional(),
  runsTool: z.string().min(1).optional(),
});

export const themeDeclSchema = z.object({
  id: contribId,
  label: z.string().min(1),
  appearance: z.enum(['dark', 'light']),
  tokens: z.record(z.string()),
});

const contributionScopeSchema = z.enum(['application', 'editor', 'project', 'module']);

export const editorActionDeclSchema = z.object({
  id: contribId,
  label: z.string().min(1),
  category: z.string().optional(),
  icon: z.string().optional(),
  shortcut: z.string().optional(),
  runsTool: z.string().min(1).optional(),
  scope: contributionScopeSchema.extract(['editor', 'project', 'module']).optional(),
  activation: activationRuleSchema.optional(),
});

export const statusBarItemDeclSchema = z.object({
  id: contribId,
  label: z.string().min(1),
  tooltip: z.string().optional(),
  icon: z.string().optional(),
  alignment: z.enum(['left', 'right']).optional(),
  priority: z.number().optional(),
  runsTool: z.string().min(1).optional(),
  scope: contributionScopeSchema.extract(['application', 'project', 'module']).optional(),
  activation: activationRuleSchema.optional(),
});

export const runConfigurationDeclSchema = z.object({
  id: contribId,
  title: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  kind: z.string().optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: relPath.optional(),
  env: z.record(z.string()).optional(),
  scope: contributionScopeSchema.extract(['project', 'module']).optional(),
  activation: activationRuleSchema.optional(),
});

export const projectModuleDeclSchema = z.object({
  id: contribId,
  title: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  activation: activationRuleSchema,
  tools: z.array(z.string().min(1)).optional(),
  toolWindows: z.array(toolWindowDeclSchema).optional(),
  editorActions: z.array(editorActionDeclSchema).optional(),
  statusBarItems: z.array(statusBarItemDeclSchema).optional(),
  runConfigurations: z.array(runConfigurationDeclSchema).optional(),
});

export const providerRuntimeDeclSchema = z
  .object({
    protocol: z.literal('provider-adapter-v2'),
    entry: relPath.optional(),
    kinds: z.array(z.string().min(1)).min(1),
  })
  .strict();

// A plugin-contributed provider is a full declarative ProviderSpec — validated
// by `thirdPartyProviderSpecSchema` (from @mcp/provider-sdk) where `providers` is
// declared on `appManifestSchema` below. The old lossy `providerDeclSchema`
// (metadata + supports* booleans, bundle-imported adapters) is retired.

/**
 * Capabilities the plugin requires. Validated here so install can surface the
 * exact scopes for approval; the host re-checks the granted subset on every
 * `ctx.fs`/`ctx.exec`/`ctx.storage` call. fs globs reuse the `relPath` guard
 * (no traversal/absolute).
 */
export const permissionsSchema = z
  .object({
    fs: z
      .object({
        read: z.array(relPath).optional(),
        write: z.array(relPath).optional(),
      })
      .strict()
      .optional(),
    exec: z.object({ allow: z.array(z.string().min(1)).min(1) }).strict().optional(),
    storage: z.boolean().optional(),
  })
  .strict();

function buildAppManifestSchema(providers: z.ZodTypeAny) {
  return z.object({
    worker: relPath.optional(),
    tools: z.array(pluginToolDeclSchema).optional(),
    toolWindows: z.array(toolWindowDeclSchema).optional(),
    commands: z.array(commandDeclSchema).optional(),
    themes: z.array(themeDeclSchema).optional(),
    editorActions: z.array(editorActionDeclSchema).optional(),
    statusBarItems: z.array(statusBarItemDeclSchema).optional(),
    runConfigurations: z.array(runConfigurationDeclSchema).optional(),
    modules: z.array(projectModuleDeclSchema).optional(),
    providerRuntime: providerRuntimeDeclSchema.optional(),
    permissions: permissionsSchema.optional(),
    // A plugin contributes a provider as a full declarative ProviderSpec (DATA).
    providers: z.array(providers).optional(),
  });
}

// Default (third-party) manifest schema: rejects host-only provider capabilities
// (auth.hooks, sdk:* discovery/test, unknown wires) so a plugin can't claim them.
export const appManifestSchema = buildAppManifestSchema(thirdPartyProviderSpecSchema);

// First-party (bundled) lane: a plugin shipped INSIDE the app (source 'bundled')
// may carry host capabilities — its providers validate against the FULL schema.
// The provider LOADER stays the authoritative runtime gate (isFirstPartyBundled),
// so this only governs whether the install snapshot is allowed to persist them.
const firstPartyAppManifestSchema = buildAppManifestSchema(providerSpecSchema);

export function parseAppManifest(
  json: unknown,
  opts?: { trustProviders?: boolean },
): z.infer<typeof appManifestSchema> {
  const schema = opts?.trustProviders ? firstPartyAppManifestSchema : appManifestSchema;
  return schema.parse(json) as z.infer<typeof appManifestSchema>;
}
