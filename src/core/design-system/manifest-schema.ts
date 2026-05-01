import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const DsDependencyEntrySchema = z.object({
  name: z.string().min(1),
  version: z.string().nullable().optional(),
  source: z.string().min(1),
  files: z.array(z.string()).default([]),
}).strict();

export const DsFontDependencySchema = z.object({
  family: z.string().min(1),
  source: z.enum(['google', 'self-hosted', 'system', 'unknown']).default('unknown'),
  weights: z.array(z.union([z.number(), z.string()])).optional(),
  url: z.string().optional(),
  files: z.array(z.string()).default([]),
}).strict();

export const DsDependenciesSchema = z.object({
  css_frameworks: z.array(DsDependencyEntrySchema).default([]),
  icon_fonts: z.array(DsDependencyEntrySchema).default([]),
  js_libs: z.array(DsDependencyEntrySchema).default([]),
  fonts: z.array(DsFontDependencySchema).default([]),
}).strict();

export const DsPropsSchema = z.record(z.unknown()).refine(
  (value) => Object.keys(value).length > 0,
  'props_schema must be a non-empty object',
);

export const DsSourceRefSchema = z.union([
  z.string().min(1),
  z.object({
    file: z.string().min(1),
    line: z.number().int().positive().optional(),
    selector: z.string().optional(),
  }).strict(),
]);

export const DsComponentManifestSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['atom', 'page-template']),
  html: z.string().min(1),
  css_classes: z.array(z.string().min(1)).min(1),
  source_refs: z.array(DsSourceRefSchema).min(1),
  props_schema: DsPropsSchema,
  dependencies: z.array(z.string().min(1)).default([]),
  confidence: z.number().min(0).max(1),
  description: z.string().optional(),
  category: z.string().optional(),
}).strict();

export const DsLayoutManifestSchema = z.object({
  name: z.string().min(1),
  html: z.string().min(1),
  css_classes: z.array(z.string()).default([]),
  source_refs: z.array(DsSourceRefSchema).min(1),
  confidence: z.number().min(0).max(1).optional(),
}).strict();

export const DesignSystemManifestV2Schema = z.object({
  manifest_version: z.literal('2'),
  name: z.string().min(1).optional(),
  source_inventory_path: z.string().optional(),
  dependencies: DsDependenciesSchema,
  tokens: z.record(z.unknown()).default({}),
  layouts: z.array(DsLayoutManifestSchema).default([]),
  components: z.array(DsComponentManifestSchema).min(1),
}).strict();

export type DesignSystemManifestV2 = z.infer<typeof DesignSystemManifestV2Schema>;

export type ManifestErrorCode =
  | 'schema.invalid'
  | 'schema.duplicate_name'
  | 'css.dangling_in_html'
  | 'css.dangling_in_styles'
  | 'props.foreign_vocabulary'
  | 'vocab.leak'
  | 'semantic.shards_missing';

export interface ManifestValidationIssue {
  path: string;
  message: string;
  code?: ManifestErrorCode;
}

export interface ManifestSemanticOptions {
  /** Path to the source-inventory shard directory (e.g. `<workdir>/source-inventory`). */
  sourceInventoryDir?: string;
}

export interface ManifestValidationOptions {
  strict?: boolean;
  /** Run cross-checks against source-inventory shards. Pass `false` to disable. */
  semantic?: ManifestSemanticOptions | false;
}

export interface ManifestValidationResult {
  ok: boolean;
  errors: ManifestValidationIssue[];
  warnings: ManifestValidationIssue[];
  manifest?: DesignSystemManifestV2;
}

export function validateDesignSystemManifestData(
  value: unknown,
  opts: { strict?: boolean } = {},
): ManifestValidationResult {
  const parsed = DesignSystemManifestV2Schema.safeParse(value);
  const errors: ManifestValidationIssue[] = [];
  const warnings: ManifestValidationIssue[] = [];

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({
        path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
        message: issue.message,
        code: 'schema.invalid',
      });
    }
    return { ok: false, errors, warnings };
  }

  const manifest = parsed.data;
  const componentNames = new Set<string>();
  for (const [index, component] of manifest.components.entries()) {
    const basePath = `components.${index}`;
    if (componentNames.has(component.name)) {
      errors.push({
        path: `${basePath}.name`,
        message: `duplicate component name '${component.name}'`,
        code: 'schema.duplicate_name',
      });
    }
    componentNames.add(component.name);

    if (opts.strict !== false) {
      const htmlClassCount = component.css_classes.filter((cls) =>
        component.html.includes(cls),
      ).length;
      if (htmlClassCount === 0) {
        warnings.push({
          path: `${basePath}.css_classes`,
          message: 'none of the declared css_classes appear in html',
          code: 'css.dangling_in_html',
        });
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, manifest };
}

interface InventoryShardBundle {
  styles?: { stylesheets?: Array<{ selectors?: string[]; classes?: string[]; css_variables?: Record<string, string> }> };
  dependencies?: { dependencies?: { css_frameworks?: Array<{ name?: string }>; icon_fonts?: Array<{ name?: string }>; js_libs?: Array<{ name?: string }> } };
  components?: { component_candidates?: Array<{ name?: string; css_classes?: string[] }> };
}

async function loadInventoryShards(dir: string): Promise<{ shards: InventoryShardBundle; missing: string[] }> {
  const shards: InventoryShardBundle = {};
  const missing: string[] = [];
  for (const name of ['styles', 'dependencies', 'components'] as const) {
    try {
      const raw = await readFile(join(dir, `${name}.json`), 'utf8');
      shards[name] = JSON.parse(raw);
    } catch {
      missing.push(`${name}.json`);
    }
  }
  return { shards, missing };
}

function extractPropEntries(
  propsSchema: Record<string, unknown>,
): Array<{ key: string; values: string[] }> {
  const out: Array<{ key: string; values: string[] }> = [];

  // Shape A — JSON-schema-style: { properties: { variant: { enum: [...] } } }
  const properties = propsSchema.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [key, def] of Object.entries(properties as Record<string, unknown>)) {
      out.push({ key, values: extractEnumValues(def) });
    }
    return out;
  }

  // Shape B — flat skill-style: { variant: { values: [...] } }
  for (const [key, def] of Object.entries(propsSchema)) {
    out.push({ key, values: extractEnumValues(def) });
  }
  return out;
}

function extractEnumValues(def: unknown): string[] {
  if (!def || typeof def !== 'object') return [];
  const obj = def as Record<string, unknown>;
  const candidates: unknown[] = [];
  if (Array.isArray(obj.values)) candidates.push(...obj.values);
  if (Array.isArray(obj.enum)) candidates.push(...obj.enum);
  if (Array.isArray(obj.options)) candidates.push(...obj.options);
  return candidates.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

const WELL_KNOWN_LEAK_VOCAB: Record<string, Record<string, string[]>> = {
  variant: {
    'material-ui': ['contained', 'outlined', 'text', 'filled'],
    'ant-design': ['dashed', 'link', 'ghost'],
    'chakra-ui': ['solid', 'subtle'],
  },
  type: {
    'ant-design': ['dashed', 'link', 'ghost'],
  },
  appearance: {
    'fluent-ui': ['subtle', 'transparent', 'outline'],
  },
};

function detectVocabLeak(
  propKey: string,
  value: string,
  presentFrameworks: Set<string>,
): { framework: string } | null {
  const entry = WELL_KNOWN_LEAK_VOCAB[propKey.toLowerCase()];
  if (!entry) return null;
  for (const [framework, vocab] of Object.entries(entry)) {
    if (!vocab.includes(value)) continue;
    const aliases = [framework, framework.replace('-ui', ''), framework.replace('-design', '')];
    if (aliases.some((alias) => presentFrameworks.has(alias))) return null;
    return { framework };
  }
  return null;
}

function findCssEvidence(args: {
  value: string;
  propKey: string;
  baseClasses: string[];
  allClasses: Set<string>;
  allSelectors: string[];
  cssVariables: Set<string>;
  tokens: Record<string, unknown>;
}): boolean {
  const { value, propKey, baseClasses, allClasses, allSelectors, cssVariables, tokens } = args;

  for (const base of baseClasses) {
    if (allClasses.has(`${base}-${value}`)) return true;
    if (allClasses.has(`${value}-${base}`)) return true;
  }
  if (allClasses.has(value)) return true;

  if (cssVariables.has(`--${propKey}-${value}`) || cssVariables.has(`--${value}`)) return true;

  const dataPattern = `[data-${propKey}=`;
  for (const sel of allSelectors) {
    if (sel.includes(dataPattern) && sel.includes(value)) return true;
  }

  if (tokens && typeof tokens === 'object') {
    const stack: unknown[] = [tokens];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      if (typeof node === 'string') {
        if (node === value) return true;
        continue;
      }
      if (typeof node === 'object') {
        for (const v of Object.values(node as Record<string, unknown>)) stack.push(v);
        for (const k of Object.keys(node as Record<string, unknown>)) {
          if (k === value) return true;
        }
      }
    }
  }
  return false;
}

export async function validateManifestSemantic(
  manifest: DesignSystemManifestV2,
  opts: ManifestSemanticOptions,
): Promise<{ errors: ManifestValidationIssue[]; warnings: ManifestValidationIssue[] }> {
  const errors: ManifestValidationIssue[] = [];
  const warnings: ManifestValidationIssue[] = [];

  if (!opts.sourceInventoryDir) {
    warnings.push({
      path: '(semantic)',
      message: 'sourceInventoryDir not provided — skipping semantic checks',
      code: 'semantic.shards_missing',
    });
    return { errors, warnings };
  }

  const { shards, missing } = await loadInventoryShards(opts.sourceInventoryDir);
  if (missing.length === 3) {
    warnings.push({
      path: '(semantic)',
      message: `no inventory shards found in ${opts.sourceInventoryDir} — skipping semantic checks`,
      code: 'semantic.shards_missing',
    });
    return { errors, warnings };
  }

  const allClasses = new Set<string>();
  const allSelectors: string[] = [];
  const cssVariables = new Set<string>();
  for (const sheet of shards.styles?.stylesheets ?? []) {
    for (const cls of sheet.classes ?? []) allClasses.add(cls);
    for (const sel of sheet.selectors ?? []) allSelectors.push(sel);
    for (const varName of Object.keys(sheet.css_variables ?? {})) cssVariables.add(varName);
  }

  const presentFrameworks = new Set<string>();
  for (const dep of shards.dependencies?.dependencies?.css_frameworks ?? []) {
    if (dep.name) presentFrameworks.add(dep.name.toLowerCase());
  }
  for (const dep of manifest.dependencies.css_frameworks) {
    presentFrameworks.add(dep.name.toLowerCase());
  }

  const stylesEmpty = allClasses.size === 0 && allSelectors.length === 0;

  for (const [index, component] of manifest.components.entries()) {
    const basePath = `components.${index}`;

    if (!stylesEmpty) {
      for (const cls of component.css_classes) {
        if (!allClasses.has(cls)) {
          errors.push({
            path: `${basePath}.css_classes.${cls}`,
            message: `class '${cls}' is not present in any source stylesheet`,
            code: 'css.dangling_in_styles',
          });
        }
      }
    }

    const propsSchema = component.props_schema as Record<string, unknown>;
    for (const { key: propKey, values } of extractPropEntries(propsSchema)) {
      if (values.length === 0) continue;
      for (const value of values) {
        if (stylesEmpty) continue;
        const evidence = findCssEvidence({
          value,
          propKey,
          baseClasses: component.css_classes,
          allClasses,
          allSelectors,
          cssVariables,
          tokens: manifest.tokens as Record<string, unknown>,
        });
        if (evidence) continue;

        const leak = detectVocabLeak(propKey, value, presentFrameworks);
        if (leak) {
          const presentList = presentFrameworks.size > 0 ? [...presentFrameworks].join('/') : 'no framework declared';
          errors.push({
            path: `${basePath}.props_schema.${propKey}.values`,
            message: `value '${value}' looks like ${leak.framework} vocabulary, but the source CSS framework is ${presentList} and no rule matches '.<base>-${value}', '.${value}', or '[data-${propKey}=${value}]'`,
            code: 'vocab.leak',
          });
        } else {
          errors.push({
            path: `${basePath}.props_schema.${propKey}.values`,
            message: `value '${value}' has no CSS evidence (no '.<class>-${value}', '.${value}', '[data-${propKey}=${value}]' or token match)`,
            code: 'props.foreign_vocabulary',
          });
        }
      }
    }
  }

  return { errors, warnings };
}

export async function validateDesignSystemManifestFile(
  manifestPath: string,
  opts: ManifestValidationOptions = {},
): Promise<ManifestValidationResult> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (e) {
    return {
      ok: false,
      errors: [{ path: manifestPath, message: `failed to read manifest: ${(e as Error).message}`, code: 'schema.invalid' }],
      warnings: [],
    };
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      errors: [{ path: manifestPath, message: `invalid JSON: ${(e as Error).message}`, code: 'schema.invalid' }],
      warnings: [],
    };
  }

  const baseResult = validateDesignSystemManifestData(data, { strict: opts.strict });
  if (!baseResult.ok || !baseResult.manifest) return baseResult;

  if (opts.semantic === false) return baseResult;
  const semanticOpts: ManifestSemanticOptions =
    opts.semantic && typeof opts.semantic === 'object'
      ? opts.semantic
      : { sourceInventoryDir: join(dirname(manifestPath), 'source-inventory') };

  const semanticResult = await validateManifestSemantic(baseResult.manifest, semanticOpts);
  return {
    ok: baseResult.errors.length === 0 && semanticResult.errors.length === 0,
    errors: [...baseResult.errors, ...semanticResult.errors],
    warnings: [...baseResult.warnings, ...semanticResult.warnings],
    manifest: baseResult.manifest,
  };
}

function formatIssue(issue: ManifestValidationIssue): string {
  const codeTag = issue.code ? ` [${issue.code}]` : '';
  return `- ${issue.path}: ${issue.message}${codeTag}`;
}

export function formatManifestValidation(result: ManifestValidationResult): string {
  const lines: string[] = [];
  if (result.errors.length > 0) {
    lines.push('Errors:');
    for (const issue of result.errors) lines.push(formatIssue(issue));
  }
  if (result.warnings.length > 0) {
    lines.push('Warnings:');
    for (const issue of result.warnings) lines.push(formatIssue(issue));
  }
  if (lines.length === 0) return 'Manifest is valid.';
  return lines.join('\n');
}
