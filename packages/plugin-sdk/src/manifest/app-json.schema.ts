/**
 * `.app.json` — the proprietary IDE-contribution manifest layered on top of
 * the Claude Code core. Declarative on purpose: the host reads contributions
 * (tool windows, commands, themes, agent-tool metadata) WITHOUT executing
 * plugin code. The matching handlers live in the bundled `worker` entry and
 * are keyed by `name`/`id`.
 */
import { z } from 'zod';
import { thirdPartyProviderSpecSchema, providerSpecSchema } from '@mcp/provider-sdk';
import { CONTRIB_ID_RE, SEMVER_RE, relPath } from './common.js';

const contribId = z.string().regex(CONTRIB_ID_RE, 'id must be kebab/snake-case');

/**
 * Declarative output-shaping contract forwarded to the agent runtime. Keep
 * this schema independent from @mcp/code-agent so plugin manifests remain a
 * data-only contract that can be validated without loading the agent package.
 */
export const pluginToolOutputPolicySchema = z
  .object({
    mode: z.enum([
      'generic',
      'authoritative',
      'page',
      'line_range',
      'rows',
      'logs',
      'diff',
      'search',
      'structured',
    ]),
    reducer: z.enum(['smart', 'none']).optional(),
    recovery: z.enum(['output_store', 'cursor', 'section', 'rerun', 'none']).optional(),
    maxInlineChars: z.number().int().positive().optional(),
    preserveOnError: z.boolean().optional(),
  })
  .strict();

export const pluginToolDeclSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: z.record(z.unknown()).default({}),
  riskLevel: z.enum(['read', 'write', 'execute', 'admin']).optional(),
  mutates: z.boolean().optional(),
  outputPolicy: pluginToolOutputPolicySchema.optional(),
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

export const editorGutterLineMatcherSchema = z
  .object({
    text: z.string().min(1).max(256),
    match: z.enum(['equals', 'startsWith', 'contains', 'word']),
    trim: z.boolean().optional(),
    caseSensitive: z.boolean().optional(),
  })
  .strict();

export const editorDocumentSelectorSchema = z
  .object({
    filePatterns: z.array(z.string().min(1).max(256)).min(1).max(32).optional(),
    languageIds: z.array(z.string().min(1).max(64)).min(1).max(16).optional(),
  })
  .strict()
  .refine(
    (selector) => Boolean(selector.filePatterns?.length || selector.languageIds?.length),
    {
      message: 'documentSelector requires filePatterns or languageIds',
    },
  );

export const editorGutterDeclSchema = z
  .object({
    line: editorGutterLineMatcherSchema,
    occurrence: z.enum(['first', 'all']).optional(),
    icon: z.enum(['run', 'build', 'inspect']).optional(),
    tooltip: z.string().min(1).max(256).optional(),
  })
  .strict();

export const editorActionDeclSchema = z.object({
  id: contribId,
  label: z.string().min(1),
  category: z.string().optional(),
  icon: z.string().optional(),
  shortcut: z.string().optional(),
  runsTool: z.string().min(1).optional(),
  toolArgs: z.record(z.unknown()).optional(),
  documentSelector: editorDocumentSelectorSchema.optional(),
  gutter: editorGutterDeclSchema.optional(),
  scope: contributionScopeSchema.extract(['editor', 'project', 'module']).optional(),
  activation: activationRuleSchema.optional(),
});

// Keep the exported action schema as a ZodObject for SDK consumers that extend
// or merge contribution shapes. Cross-field invariants belong to the complete
// manifest parsing lane and are applied at every action nesting point below.
const manifestEditorActionDeclSchema = editorActionDeclSchema
  .superRefine((action, ctx) => {
    if (action.gutter && !action.runsTool) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['runsTool'], message: 'gutter requires runsTool' });
    }
    if (action.gutter && !action.documentSelector) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['documentSelector'],
        message: 'gutter requires documentSelector',
      });
    }
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

export const debuggerCapabilitiesDeclSchema = z
  .object({
    launch: z.boolean().optional(),
    attach: z.boolean().optional(),
    conditionalBreakpoints: z.boolean().optional(),
    hitConditionalBreakpoints: z.boolean().optional(),
    logpoints: z.boolean().optional(),
    exceptionBreakpoints: z.boolean().optional(),
  })
  .strict();

export const debuggerDeclSchema = z
  .object({
    id: contribId,
    label: z.string().min(1).max(128),
    description: z.string().max(512).optional(),
    languageIds: z.array(z.string().min(1).max(64)).min(1).max(32),
    filePatterns: z.array(z.string().min(1).max(256)).min(1).max(64).optional(),
    runnerManagers: z.array(z.string().min(1).max(64)).min(1).max(32).optional(),
    supports: debuggerCapabilitiesDeclSchema.optional(),
    activation: activationRuleSchema.optional(),
  })
  .strict();

const npmPackageNameSchema = z
  .string()
  .regex(
    /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/,
    'package must be a lowercase npm package name',
  );

export const languageServerInstallDeclSchema = z
  .object({
    kind: z.literal('npm'),
    package: npmPackageNameSchema,
    version: z.string().regex(SEMVER_RE, 'version must be exact semver'),
  })
  .strict();

const semverRangeToken = String.raw`(?:\^|~|>=|<=|>|<)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
const semverRangePattern = new RegExp(
  `^${semverRangeToken}(?:\\s+${semverRangeToken})*(?:\\s*\\|\\|\\s*${semverRangeToken}(?:\\s+${semverRangeToken})*)*$`,
);
const projectVersionRangePattern = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)\.(\d+)\.(\d+)$/;

type VersionTuple = readonly [number, number, number];
interface ProjectVersionBounds {
  lower: VersionTuple;
  upper: VersionTuple;
}

function compareVersionTuple(a: VersionTuple, b: VersionTuple): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function parseProjectVersionBounds(range: string): ProjectVersionBounds | null {
  const match = projectVersionRangePattern.exec(range);
  if (!match) return null;
  return {
    lower: [Number(match[1]), Number(match[2]), Number(match[3])],
    upper: [Number(match[4]), Number(match[5]), Number(match[6])],
  };
}

const semverRangeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(semverRangePattern, 'must be a semver range with complete x.y.z versions');

const projectVersionRangeSchema = z
  .string()
  .regex(
    projectVersionRangePattern,
    'projectVersionRange must be a normalized half-open range such as >=17.0.0 <18.0.0',
  )
  .refine((range) => {
    const bounds = parseProjectVersionBounds(range);
    return bounds !== null && compareVersionTuple(bounds.lower, bounds.upper) < 0;
  }, 'projectVersionRange lower bound must be less than its upper bound');

export const languageServerCompatibilityProfileDeclSchema = z
  .object({
    id: contribId,
    projectVersionRange: projectVersionRangeSchema,
    supportTier: z.enum(['full', 'best-effort', 'unsupported']),
    serverNodeRange: semverRangeSchema,
    typescriptRange: semverRangeSchema.optional(),
    languageServiceVersion: z
      .string()
      .regex(SEMVER_RE, 'languageServiceVersion must be exact semver'),
    install: languageServerInstallDeclSchema,
    entryRelPath: relPath,
    args: z.array(z.string().min(1).max(512)).max(32),
  })
  .strict();

export const languageServerCompatibilityDeclSchema = z
  .object({
    projectResolver: z.literal('angular-core'),
    profiles: z.array(languageServerCompatibilityProfileDeclSchema).min(1).max(32),
  })
  .strict()
  .superRefine(({ profiles }, ctx) => {
    const ids = new Set<string>();
    for (let i = 0; i < profiles.length; i += 1) {
      const profile = profiles[i];
      if (ids.has(profile.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['profiles', i, 'id'],
          message: `duplicate compatibility profile id: ${profile.id}`,
        });
      }
      ids.add(profile.id);

      const current = parseProjectVersionBounds(profile.projectVersionRange);
      if (!current) continue;
      for (let j = 0; j < i; j += 1) {
        const previous = parseProjectVersionBounds(profiles[j].projectVersionRange);
        if (!previous) continue;
        const overlaps = compareVersionTuple(current.lower, previous.upper) < 0
          && compareVersionTuple(previous.lower, current.upper) < 0;
        if (overlaps) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['profiles', i, 'projectVersionRange'],
            message: `overlaps compatibility profile ${profiles[j].id}`,
          });
        }
      }
    }
  });

export const languageServerRoutingDeclSchema = z
  .object({
    mode: z.enum(['primary', 'overlay']),
    priority: z.number().int().min(-1_000).max(1_000).optional(),
  })
  .strict();

export const languageServerDeclSchema = z
  .object({
    id: contribId,
    label: z.string().min(1).max(128),
    languages: z.array(z.string().min(1).max(64)).min(1).max(32),
    activation: activationRuleSchema.refine(
      (rule) => Boolean(rule.whenFiles?.length || rule.whenPackageDep?.length),
      { message: 'language server activation requires whenFiles or whenPackageDep' },
    ),
    install: languageServerInstallDeclSchema,
    entryRelPath: relPath,
    args: z.array(z.string().min(1).max(512)).max(32).optional(),
    launchKind: z.enum(['standard', 'angular']).optional(),
    compatibility: languageServerCompatibilityDeclSchema.optional(),
    routing: languageServerRoutingDeclSchema,
    sizeLabel: z.string().min(1).max(64),
  })
  .strict();

export const projectModuleDeclSchema = z.object({
  id: contribId,
  title: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  activation: activationRuleSchema,
  tools: z.array(z.string().min(1)).optional(),
  toolWindows: z.array(toolWindowDeclSchema).optional(),
  editorActions: z.array(manifestEditorActionDeclSchema).optional(),
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

export const debuggerRuntimeDeclSchema = z
  .object({
    protocol: z.literal('debug-adapter-v1'),
    entry: relPath.optional(),
    adapters: z.array(contribId).min(1),
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

function buildAppManifestSchema(
  providers: z.ZodTypeAny,
  options: { allowLanguageServers: boolean },
) {
  return z.object({
    worker: relPath.optional(),
    tools: z.array(pluginToolDeclSchema).optional(),
    toolWindows: z.array(toolWindowDeclSchema).optional(),
    commands: z.array(commandDeclSchema).optional(),
    themes: z.array(themeDeclSchema).optional(),
    editorActions: z.array(manifestEditorActionDeclSchema).optional(),
    statusBarItems: z.array(statusBarItemDeclSchema).optional(),
    runConfigurations: z.array(runConfigurationDeclSchema).optional(),
    debuggers: z.array(debuggerDeclSchema).optional(),
    languageServers: z.array(languageServerDeclSchema).optional(),
    modules: z.array(projectModuleDeclSchema).optional(),
    providerRuntime: providerRuntimeDeclSchema.optional(),
    debuggerRuntime: debuggerRuntimeDeclSchema.optional(),
    permissions: permissionsSchema.optional(),
    // A plugin contributes a provider as a full declarative ProviderSpec (DATA).
    providers: z.array(providers).optional(),
  }).superRefine((manifest, ctx) => {
    if (!options.allowLanguageServers && manifest.languageServers !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['languageServers'],
        message: 'languageServers are restricted to trusted first-party bundled plugins',
      });
    }
  });
}

// Default (third-party) manifest schema: rejects language-server execution and
// host-only provider capabilities (auth.hooks, sdk:* discovery/test, unknown
// wires) so a plugin cannot claim privileged host behavior.
export const appManifestSchema = buildAppManifestSchema(thirdPartyProviderSpecSchema, {
  allowLanguageServers: false,
});

// First-party (bundled) lane: a plugin shipped INSIDE the app (source 'bundled')
// may carry host capabilities. Runtime loaders stay authoritative, so this only
// governs whether the install snapshot is allowed to persist them.
const firstPartyAppManifestSchema = buildAppManifestSchema(providerSpecSchema, {
  allowLanguageServers: true,
});

export interface ParseAppManifestOptions {
  /** Enables host-only contributions for plugins shipped inside the app. */
  trustFirstParty?: boolean;
  /** @deprecated Use trustFirstParty. Retained for bundled-provider callers. */
  trustProviders?: boolean;
}

export function parseAppManifest(
  json: unknown,
  opts?: ParseAppManifestOptions,
): z.infer<typeof appManifestSchema> {
  const schema = opts?.trustFirstParty || opts?.trustProviders
    ? firstPartyAppManifestSchema
    : appManifestSchema;
  return schema.parse(json) as z.infer<typeof appManifestSchema>;
}
