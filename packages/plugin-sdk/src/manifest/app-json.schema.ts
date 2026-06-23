/**
 * `.app.json` — the proprietary IDE-contribution manifest layered on top of
 * the Claude Code core. Declarative on purpose: the host reads contributions
 * (tool windows, commands, themes, agent-tool metadata) WITHOUT executing
 * plugin code. The matching handlers live in the bundled `worker` entry and
 * are keyed by `name`/`id`.
 */
import { z } from 'zod';
import { CONTRIB_ID_RE, relPath } from './common.js';

const contribId = z.string().regex(CONTRIB_ID_RE, 'id must be kebab/snake-case');

export const pluginToolDeclSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: z.record(z.unknown()).default({}),
  riskLevel: z.enum(['read', 'write', 'execute', 'admin']).optional(),
  mutates: z.boolean().optional(),
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
});

export const themeDeclSchema = z.object({
  id: contribId,
  label: z.string().min(1),
  appearance: z.enum(['dark', 'light']),
  tokens: z.record(z.string()),
});

const pricingEntrySchema = z
  .object({ inputPer1M: z.number(), outputPer1M: z.number() })
  .strict();

const providerVisualSchema = z
  .object({ icon: z.string().min(1), fg: z.string().min(1), bg: z.string().min(1) })
  .strict();

/**
 * Declarative description of a plugin-contributed LLM provider. The HOST reads
 * this (no plugin code runs) to list the provider in the admin picker with its
 * metadata + visual. The `supports*` booleans report which roles the bundle's
 * actual functions cover; the provider-host loader imports the bundle in-process
 * to wire those functions when registering the provider.
 */
export const providerDeclSchema = z
  .object({
    kind: z.string().min(1),
    displayName: z.string().min(1),
    credKind: z.enum(['api-key', 'oauth', 'aws']),
    envVars: z.array(z.string()).default([]),
    defaultBaseURL: z.string().optional(),
    defaultModels: z.array(z.string()).default([]),
    defaultModel: z.string().optional(),
    pricing: z.record(pricingEntrySchema).default({}),
    capabilities: z.record(z.unknown()).optional(),
    visual: providerVisualSchema.optional(),
    supportsCoder: z.boolean().default(false),
    supportsIndexer: z.boolean().default(false),
    supportsFetchModels: z.boolean().default(false),
    supportsTestConnection: z.boolean().default(false),
  })
  .strict();

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

export const appManifestSchema = z.object({
  worker: relPath.optional(),
  tools: z.array(pluginToolDeclSchema).optional(),
  toolWindows: z.array(toolWindowDeclSchema).optional(),
  commands: z.array(commandDeclSchema).optional(),
  themes: z.array(themeDeclSchema).optional(),
  permissions: permissionsSchema.optional(),
  providers: z.array(providerDeclSchema).optional(),
});

export function parseAppManifest(json: unknown) {
  return appManifestSchema.parse(json);
}
