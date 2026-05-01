import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import {
  validateDesignSystemManifestData,
  type DesignSystemManifestV2,
} from './manifest-schema.js';

export interface PackageAuditIssue {
  code: string;
  message: string;
  file?: string;
}

export interface PackageAuditResult {
  ok: boolean;
  errors: PackageAuditIssue[];
  warnings: PackageAuditIssue[];
  details: {
    packageName?: string;
    componentCount?: number;
    storyCount?: number;
    mcpManifest?: boolean;
    storybookStatic?: boolean;
  };
}

interface StoryAuditContext {
  pkgDir: string;
  manifest: DesignSystemManifestV2 | null;
}

export async function auditDesignSystemPackage(pkgDir: string): Promise<PackageAuditResult> {
  const errors: PackageAuditIssue[] = [];
  const warnings: PackageAuditIssue[] = [];
  const details: PackageAuditResult['details'] = {};

  const packageJsonPath = join(pkgDir, 'package.json');
  const packageJson = await readJson(packageJsonPath, errors, 'package.json');
  if (!packageJson) return { ok: false, errors, warnings, details };

  details.packageName = typeof packageJson.name === 'string' ? packageJson.name : undefined;

  const files = Array.isArray(packageJson.files)
    ? packageJson.files.filter((v: unknown): v is string => typeof v === 'string')
    : [];

  if (files.length === 0) {
    errors.push({ code: 'package.files_missing', message: 'package.json#files must include published artifacts.', file: packageJsonPath });
  }
  requireFileEntry(files, 'dist', errors, packageJsonPath);
  requireFileEntry(files, 'mcp', errors, packageJsonPath);
  requireFileEntry(files, 'storybook-static', errors, packageJsonPath);
  requireFileEntry(files, 'docs.md', errors, packageJsonPath);
  requireFileEntry(files, 'README.md', warnings, packageJsonPath);

  if (!packageJson.exports || typeof packageJson.exports !== 'object') {
    errors.push({ code: 'package.exports_missing', message: 'package.json#exports is required.', file: packageJsonPath });
  }
  if (!packageJson.peerDependencies || typeof packageJson.peerDependencies !== 'object') {
    errors.push({ code: 'package.peer_dependencies_missing', message: 'package.json#peerDependencies is required.', file: packageJsonPath });
  }
  const dependencies = isRecord(packageJson.dependencies) ? packageJson.dependencies : {};
  const peerDependencies = isRecord(packageJson.peerDependencies) ? packageJson.peerDependencies : {};
  if (!isRecord(packageJson.dependencies)) {
    warnings.push({ code: 'package.dependencies_missing', message: 'package.json#dependencies is missing; bundled/local-only dependency packages are allowed, but runtime dependencies should be declared.', file: packageJsonPath });
  }

  const bin = packageJson.bin;
  if (!bin || typeof bin !== 'object' || Object.keys(bin as Record<string, unknown>).length === 0) {
    errors.push({ code: 'mcp.bin_missing', message: 'package.json#bin must expose the bundled MCP server.', file: packageJsonPath });
  }

  const manifestPath = join(pkgDir, 'manifest.json');
  const manifestRaw = await readJson(manifestPath, errors, 'manifest.json');
  let manifest: DesignSystemManifestV2 | null = null;
  if (manifestRaw) {
    const validation = validateDesignSystemManifestData(manifestRaw, { strict: true });
    if (!validation.ok) {
      for (const issue of validation.errors) {
        errors.push({
          code: 'manifest.invalid',
          message: `${issue.path}: ${issue.message}`,
          file: manifestPath,
        });
      }
    } else {
      manifest = validation.manifest ?? null;
      details.componentCount = manifest?.components.length;
      for (const issue of validation.warnings) {
        warnings.push({
          code: 'manifest.warning',
          message: `${issue.path}: ${issue.message}`,
          file: manifestPath,
        });
      }
      for (const dependencyName of manifestPackageDependencyNames(manifest)) {
        if (!isDeclaredDependency(dependencyName, dependencies, peerDependencies)) {
          warnings.push({
            code: 'package.dependency_not_declared',
            message: `Manifest dependency '${dependencyName}' is not declared in package.json#dependencies or #peerDependencies.`,
            file: packageJsonPath,
          });
        }
      }
    }
  }

  const mcpManifestPath = join(pkgDir, 'mcp', 'manifest.json');
  if (!existsSync(mcpManifestPath)) {
    errors.push({ code: 'mcp.manifest_missing', message: 'pkg/mcp/manifest.json is required.', file: mcpManifestPath });
  } else {
    details.mcpManifest = true;
  }

  const storybookIndex = join(pkgDir, 'storybook-static', 'index.html');
  if (!existsSync(storybookIndex)) {
    errors.push({ code: 'storybook.static_missing', message: 'pkg/storybook-static/index.html is required.', file: storybookIndex });
  } else {
    details.storybookStatic = true;
  }

  const docsPath = join(pkgDir, 'docs.md');
  if (!existsSync(docsPath)) {
    errors.push({ code: 'docs.aggregate_missing', message: 'pkg/docs.md is required for dashboard docs.', file: docsPath });
  }

  const storyAudit = await auditStories({ pkgDir, manifest });
  errors.push(...storyAudit.errors);
  warnings.push(...storyAudit.warnings);
  details.storyCount = storyAudit.storyCount;

  // Story-count plausibility — catches the `649618bc...` failure mode where
  // the agent shipped a Bootstrap admin TEMPLATE (zero generated stories,
  // monolithic theme.scss) instead of building components with stories.
  if (manifest && manifest.components.length > 0) {
    if (storyAudit.storyCount === 0) {
      errors.push({
        code: 'audit.no_stories',
        message: `manifest declares ${manifest.components.length} components but zero *.stories.* files were found under pkg/src — this is the symptom of an extractor that copied the source theme verbatim instead of generating components.`,
        file: pkgDir,
      });
    } else if (storyAudit.storyCount < manifest.components.length) {
      warnings.push({
        code: 'audit.stories_below_components',
        message: `manifest declares ${manifest.components.length} components but only ${storyAudit.storyCount} stories were generated — coverage is incomplete.`,
        file: pkgDir,
      });
    }
  }

  // Exports completeness — every component in the manifest should be
  // reachable through package.json#exports (or the catch-all './*' path).
  if (manifest && isRecord(packageJson.exports)) {
    const exportsRecord = packageJson.exports as Record<string, unknown>;
    const exportKeys = Object.keys(exportsRecord);
    const hasWildcard = exportKeys.some((k) => k.includes('*') || k === './*');
    if (!hasWildcard) {
      for (const component of manifest.components) {
        if (component.kind !== 'atom') continue;
        const lower = component.name.toLowerCase();
        const found = exportKeys.some((k) => k.toLowerCase().includes(lower));
        if (!found) {
          errors.push({
            code: 'package.exports_component_missing',
            message: `package.json#exports has no entry for '${component.name}' (no key matches '${component.name}' and there is no wildcard export).`,
            file: packageJsonPath,
          });
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, details };
}

export function formatPackageAudit(result: PackageAuditResult): string {
  const lines: string[] = [];
  lines.push(`Package audit: ${result.ok ? 'ok' : 'failed'}`);
  if (result.details.packageName) lines.push(`Package: ${result.details.packageName}`);
  if (typeof result.details.componentCount === 'number') lines.push(`Manifest components: ${result.details.componentCount}`);
  if (typeof result.details.storyCount === 'number') lines.push(`Stories: ${result.details.storyCount}`);
  if (result.errors.length > 0) {
    lines.push('Errors:');
    for (const issue of result.errors) {
      lines.push(`- ${issue.code}${issue.file ? ` (${issue.file})` : ''}: ${issue.message}`);
    }
  }
  if (result.warnings.length > 0) {
    lines.push('Warnings:');
    for (const issue of result.warnings) {
      lines.push(`- ${issue.code}${issue.file ? ` (${issue.file})` : ''}: ${issue.message}`);
    }
  }
  return lines.join('\n');
}

async function auditStories(ctx: StoryAuditContext): Promise<{
  errors: PackageAuditIssue[];
  warnings: PackageAuditIssue[];
  storyCount: number;
}> {
  const result = await validateStoryFidelity({
    componentDir: join(ctx.pkgDir, 'src'),
    manifest: ctx.manifest,
  });
  return { errors: result.errors, warnings: result.warnings, storyCount: result.storyCount };
}

export interface StoryFidelityResult {
  ok: boolean;
  errors: PackageAuditIssue[];
  warnings: PackageAuditIssue[];
  storyCount: number;
}

/**
 * Cross-check `*.stories.{ts,tsx,jsx,js}` files in `componentDir` against the
 * manifest's `props_schema` and the sibling component's `Props` interface.
 *
 * Returns errors when a story uses argTypes / args keys absent from the
 * manifest or component, or when `argTypes.<key>.options` includes literal
 * values that are not declared in `props_schema.<key>.values`. This is the
 * exact safeguard that would have caught the "Button v1.2.2" incident
 * (Material UI vocabulary leaking into a Bootstrap-based design system).
 */
export async function validateStoryFidelity(opts: {
  componentDir: string;
  manifest: DesignSystemManifestV2 | null;
}): Promise<StoryFidelityResult> {
  const errors: PackageAuditIssue[] = [];
  const warnings: PackageAuditIssue[] = [];
  const storyFiles = existsSync(opts.componentDir)
    ? (await collectFiles(opts.componentDir)).filter((file) => /\.stories\.(tsx|ts|jsx|js)$/.test(file))
    : [];

  const manifestByComponent = new Map<string, DesignSystemManifestV2['components'][number]>();
  for (const component of opts.manifest?.components ?? []) {
    manifestByComponent.set(normalizeName(component.name), component);
  }

  for (const storyPath of storyFiles) {
    const stem = basename(storyPath).replace(/\.stories\.(tsx|ts|jsx|js)$/, '');
    const componentPath = findSiblingComponent(storyPath, stem);
    const props = componentPath ? await readComponentProps(componentPath) : new Set<string>();
    const manifestComponent = manifestByComponent.get(normalizeName(stem));
    if (!componentPath) {
      warnings.push({ code: 'stories.component_missing', message: `No sibling component found for ${basename(storyPath)}.`, file: storyPath });
    }
    if (!manifestComponent && opts.manifest) {
      errors.push({ code: 'stories.manifest_component_missing', message: `Story '${stem}' has no matching manifest component.`, file: storyPath });
    }

    const storyText = await readFile(storyPath, 'utf8');
    const storyProps = extractStoryPropUsage(storyText);
    const allowedManifestProps = new Set(Object.keys(extractManifestProperties(manifestComponent?.props_schema)));

    for (const prop of storyProps.argTypes) {
      if (props.size > 0 && !props.has(prop)) {
        errors.push({ code: 'stories.orphan_argtype', message: `argTypes.${prop} is not declared on ${stem}Props.`, file: storyPath });
      }
      if (allowedManifestProps.size > 0 && !allowedManifestProps.has(prop)) {
        errors.push({ code: 'stories.argtype_not_in_manifest', message: `argTypes.${prop} is not declared in manifest props_schema.`, file: storyPath });
      }
    }

    for (const prop of storyProps.args) {
      if (props.size > 0 && !props.has(prop)) {
        errors.push({ code: 'stories.orphan_arg', message: `args.${prop} is not declared on ${stem}Props.`, file: storyPath });
      }
      if (allowedManifestProps.size > 0 && !allowedManifestProps.has(prop)) {
        errors.push({ code: 'stories.arg_not_in_manifest', message: `args.${prop} is not declared in manifest props_schema.`, file: storyPath });
      }
    }

    for (const [prop, values] of storyProps.options) {
      const allowed = allowedValues(manifestComponent?.props_schema, prop);
      if (allowed.length === 0) continue;
      for (const value of values) {
        if (!allowed.includes(value)) {
          errors.push({
            code: 'stories.option_not_in_manifest',
            message: `argTypes.${prop}.options includes '${value}', not present in manifest props_schema.`,
            file: storyPath,
          });
        }
      }
    }

    // Variant breadth — when a component declares ≥2 enum values for any prop,
    // there should be at least 2 named stories (one per variant minimum). A
    // single story for a Button with `variant: ['primary','secondary',...]`
    // means 5 of the 6 visual states are never rendered in Storybook.
    if (manifestComponent) {
      const maxEnum = maxEnumSize(manifestComponent.props_schema);
      if (maxEnum >= 2) {
        const exportCount = countStoryExports(storyText);
        if (exportCount < 2) {
          errors.push({
            code: 'stories.insufficient_variants',
            message: `${stem} has props with ${maxEnum} enum values but only ${exportCount} story export${exportCount === 1 ? '' : 's'} — must have at least 2 named stories.`,
            file: storyPath,
          });
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, storyCount: storyFiles.length };
}

function countStoryExports(text: string): number {
  // Conservative match for CSF3-style story exports: `export const Foo = ...`
  // and `export const Foo: ... = ...`. Skips `export default` (the meta) and
  // re-exports (`export * from`).
  return (text.match(/\bexport\s+const\s+[A-Z][A-Za-z0-9_]*\s*[:=]/g) ?? []).length;
}

function maxEnumSize(schema: Record<string, unknown> | undefined): number {
  const properties = extractManifestProperties(schema);
  let max = 0;
  for (const value of Object.values(properties)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const arr = v.values ?? v.enum;
    if (Array.isArray(arr)) max = Math.max(max, arr.length);
  }
  return max;
}

async function collectFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) out.push(path);
    }
  }
  await walk(root);
  out.sort();
  return out;
}

async function readJson(path: string, errors: PackageAuditIssue[], label: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    errors.push({ code: `${label}.read_failed`, message: `Failed to read ${label}: ${(e as Error).message}`, file: path });
    return null;
  }
}

function requireFileEntry(
  files: string[],
  entry: string,
  target: PackageAuditIssue[],
  packageJsonPath: string,
): void {
  if (!files.includes(entry)) {
    target.push({
      code: 'package.files_entry_missing',
      message: `package.json#files must include "${entry}".`,
      file: packageJsonPath,
    });
  }
}

function findSiblingComponent(storyPath: string, stem: string): string | null {
  const dir = dirname(storyPath);
  for (const ext of ['.tsx', '.ts', '.jsx', '.js']) {
    const path = join(dir, `${stem}${ext}`);
    if (existsSync(path)) return path;
  }
  return null;
}

async function readComponentProps(componentPath: string): Promise<Set<string>> {
  const text = await readFile(componentPath, 'utf8');
  const stem = basename(componentPath, extname(componentPath));
  const interfaceRe = new RegExp(`(?:export\\s+)?interface\\s+${escapeRegExp(stem)}Props\\b[^\\{]*\\{`, 'm');
  const match = interfaceRe.exec(text);
  if (!match) return new Set(['children', 'className']);
  const body = extractBalanced(text, text.indexOf('{', match.index));
  const props = new Set(['children', 'className']);
  if (!body) return props;
  for (const prop of topLevelTypeKeys(body)) props.add(prop);
  return props;
}

function extractStoryPropUsage(text: string): {
  argTypes: Set<string>;
  args: Set<string>;
  options: Map<string, string[]>;
} {
  const argTypes = new Set<string>();
  const args = new Set<string>();
  const options = new Map<string, string[]>();

  for (const block of extractNamedObjectBlocks(text, 'argTypes')) {
    const keys = topLevelObjectKeys(block);
    for (const key of keys) argTypes.add(key);
    for (const key of keys) {
      const propBlock = extractPropertyObject(block, key);
      if (!propBlock) continue;
      const optionValues = extractOptions(propBlock);
      if (optionValues.length > 0) options.set(key, optionValues);
    }
  }

  for (const block of extractNamedObjectBlocks(text, 'args')) {
    for (const key of topLevelObjectKeys(block)) args.add(key);
  }

  return { argTypes, args, options };
}

function extractNamedObjectBlocks(text: string, propertyName: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:`, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const brace = text.indexOf('{', re.lastIndex);
    if (brace < 0) continue;
    const block = extractBalanced(text, brace);
    if (block) blocks.push(block);
  }
  return blocks;
}

function extractPropertyObject(objectBlock: string, propertyName: string): string | null {
  const re = new RegExp(`(?:^|[,{])\\s*${escapeRegExp(propertyName)}\\s*:`, 'm');
  const match = re.exec(objectBlock);
  if (!match) return null;
  const brace = objectBlock.indexOf('{', match.index);
  if (brace < 0) return null;
  return extractBalanced(objectBlock, brace);
}

function extractOptions(propBlock: string): string[] {
  const match = /\boptions\s*:\s*\[([\s\S]*?)\]/m.exec(propBlock);
  if (!match) return [];
  return [...match[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
}

function extractBalanced(text: string, startBrace: number): string | null {
  if (text[startBrace] !== '{') return null;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let i = startBrace; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(startBrace, i + 1);
    }
  }
  return null;
}

function topLevelObjectKeys(objectBlock: string): string[] {
  const body = objectBlock.replace(/^\{|\}$/g, '');
  const keys: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let token = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === quote && body[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    if (depth === 0 && /[A-Za-z0-9_$]/.test(ch)) {
      token += ch;
      continue;
    }
    if (depth === 0 && ch === ':' && token) {
      keys.push(token);
      token = '';
      continue;
    }
    if (depth === 0 && ch === ',') token = '';
    if (depth === 0 && !/\s/.test(ch)) token = '';
  }
  return Array.from(new Set(keys));
}

function topLevelTypeKeys(interfaceBlock: string): string[] {
  const body = interfaceBlock.replace(/^\{|\}$/g, '');
  const keys: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_$][\w$]*)\??\s*:/.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys;
}

function extractManifestProperties(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema) return {};
  const properties = schema.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    return properties as Record<string, unknown>;
  }
  return schema;
}

function allowedValues(schema: Record<string, unknown> | undefined, prop: string): string[] {
  const properties = extractManifestProperties(schema);
  const value = properties[prop] as Record<string, unknown> | undefined;
  if (!value || typeof value !== 'object') return [];
  const values = value.values ?? value.enum;
  return Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string') : [];
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function manifestPackageDependencyNames(manifest: DesignSystemManifestV2 | null): string[] {
  if (!manifest) return [];
  const names = new Set<string>();
  for (const dep of manifest.dependencies.css_frameworks) names.add(dep.name);
  for (const dep of manifest.dependencies.icon_fonts) names.add(dep.name);
  for (const dep of manifest.dependencies.js_libs) names.add(dep.name);
  return Array.from(names).sort();
}

function isDeclaredDependency(
  dependencyName: string,
  dependencies: Record<string, unknown>,
  peerDependencies: Record<string, unknown>,
): boolean {
  const declared = new Set([...Object.keys(dependencies), ...Object.keys(peerDependencies)]);
  const candidates = dependencyPackageCandidates(dependencyName);
  return candidates.some((candidate) => declared.has(candidate));
}

function dependencyPackageCandidates(name: string): string[] {
  const normalized = name.toLowerCase();
  const aliases: Record<string, string[]> = {
    'font-awesome': ['@fortawesome/fontawesome-free', 'font-awesome'],
    'fullcalendar': ['@fullcalendar/core', 'fullcalendar'],
    'datatables': ['datatables.net', 'datatables'],
    'popper.js': ['@popperjs/core', 'popper.js'],
    'bootstrap-icons': ['bootstrap-icons'],
    'chart.js': ['chart.js'],
    'choices.js': ['choices.js'],
    'countup.js': ['countup.js'],
  };
  return aliases[normalized] ?? [name];
}
