import postcss from 'postcss';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import type Parser from 'web-tree-sitter';
import { createParser, getGrammarForExtension } from '../indexer/tree-sitter/index.js';

const INVENTORY_VERSION = '1';
const MAX_TEXT_BYTES = 2_000_000;
const MAX_SNIPPET_CHARS = 12_000;

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'storybook-static',
  '.git',
  '.cache',
]);

const TEXT_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.json',
  '.md',
]);

const ASSET_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.avif',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
]);

const KNOWN_COMPONENT_CLASSES = [
  'accordion',
  'alert',
  'avatar',
  'badge',
  'breadcrumb',
  'btn',
  'calendar',
  'card',
  'chart',
  'dropdown',
  'form',
  'input-group',
  'kanban',
  'modal',
  'navbar',
  'nav',
  'pagination',
  'progress',
  'sidenav',
  'swiper',
  'table',
  'timeline',
  'toast',
  'tooltip',
  'wizard',
];

export interface InventoryDependency {
  name: string;
  version: string | null;
  source: string;
  files: string[];
}

export interface InventoryFontDependency {
  family: string;
  source: 'google' | 'self-hosted' | 'system' | 'unknown';
  weights?: Array<number | string>;
  url?: string;
  files: string[];
}

export interface InventoryDependencies {
  css_frameworks: InventoryDependency[];
  icon_fonts: InventoryDependency[];
  js_libs: InventoryDependency[];
  fonts: InventoryFontDependency[];
}

export interface InventoryPage {
  path: string;
  title: string | null;
  links: string[];
  scripts: string[];
  classes: string[];
  ids: string[];
  roles: string[];
  data_attributes: string[];
  forms: number;
  tables: number;
  canvases: number;
  plugin_markers: string[];
  tree_sitter?: InventoryTreeSitterStats;
}

export interface InventoryStylesheet {
  path: string;
  imports: string[];
  urls: string[];
  selectors: string[];
  classes: string[];
  css_variables: Record<string, string>;
  font_faces: InventoryFontDependency[];
  parse_mode: 'postcss' | 'fallback';
  tree_sitter?: InventoryTreeSitterStats;
}

export interface InventoryScript {
  path: string;
  tree_sitter?: InventoryTreeSitterStats;
}

export interface InventoryAsset {
  path: string;
  kind: 'image' | 'font' | 'svg' | 'other';
}

export interface InventoryTreeSitterStats {
  language: string;
  named_nodes: number;
  has_error: boolean;
}

export interface DerivedPropEntry {
  /** Enum values discovered from CSS rules of the form `.{base}-{value}`. */
  values: string[];
  /** `path:line` references where each value was first observed. Capped to 5. */
  evidence: string[];
}

export interface InventoryComponentCandidate {
  name: string;
  suggested_kind: 'atom' | 'page-template';
  category: string;
  tag: string;
  html: string;
  css_classes: string[];
  source_refs: string[];
  frequency: number;
  confidence: number;
  dependency_hints: string[];
  /**
   * Enum-style props inferred from CSS rules in the source. The extractor
   * agent should treat these as the ground truth for `props_schema.<key>.values`
   * — they come from real CSS evidence, not from training-data vocabulary.
   *
   * Example for a Bootstrap Button (css_classes: ['btn']):
   *   { variant: { values: ['danger','primary','secondary','success'], evidence: ['css/app.css:42'] },
   *     size:    { values: ['lg','sm'],                                evidence: ['css/app.css:67'] } }
   */
  derived_props?: Record<string, DerivedPropEntry>;
}

export interface DesignSystemSourceInventory {
  inventory_version: typeof INVENTORY_VERSION;
  generated_at: string;
  source_root: string;
  totals: {
    files: number;
    html_pages: number;
    stylesheets: number;
    scripts: number;
    assets: number;
    component_candidates: number;
  };
  dependencies: InventoryDependencies;
  pages: InventoryPage[];
  stylesheets: InventoryStylesheet[];
  scripts: InventoryScript[];
  assets: InventoryAsset[];
  component_candidates: InventoryComponentCandidate[];
  warnings: string[];
}

export type DesignSystemSourceInventoryShardName =
  | 'dependencies'
  | 'pages'
  | 'styles'
  | 'components'
  | 'warnings';

export interface DesignSystemSourceInventoryShardMap {
  dependencies: string;
  pages: string;
  styles: string;
  components: string;
  warnings: string;
}

export interface DesignSystemSourceInventoryIndex {
  inventory_version: typeof INVENTORY_VERSION;
  generated_at: string;
  source_root: string;
  totals: DesignSystemSourceInventory['totals'];
  shards: DesignSystemSourceInventoryShardMap;
  recommended_read_order: DesignSystemSourceInventoryShardName[];
  summary: {
    dependency_counts: {
      css_frameworks: number;
      icon_fonts: number;
      js_libs: number;
      fonts: number;
      assets: number;
      scripts: number;
    };
    top_dependencies: string[];
    page_samples: string[];
    component_candidate_samples: Array<{
      name: string;
      category: string;
      frequency: number;
      confidence: number;
      source_refs: string[];
    }>;
    warning_count: number;
    note: string;
  };
}

interface CandidateDraft {
  key: string;
  name: string;
  suggested_kind: 'atom' | 'page-template';
  category: string;
  tag: string;
  html: string;
  css_classes: string[];
  source_refs: Set<string>;
  frequency: number;
  confidenceBase: number;
  dependency_hints: Set<string>;
}

interface AnalyzerState {
  dependencies: InventoryDependencies;
  dependencyKeys: {
    css_frameworks: Set<string>;
    icon_fonts: Set<string>;
    js_libs: Set<string>;
    fonts: Set<string>;
  };
  candidates: Map<string, CandidateDraft>;
  parsers: Map<string, Parser>;
  warnings: string[];
  /** class name → list of `{ file, line }` occurrences (used by derived_props inference). */
  classOccurrences: Map<string, Array<{ file: string; line: number }>>;
}

export async function writeSourceInventory(
  sourceDir: string,
  outputPath: string,
): Promise<DesignSystemSourceInventory> {
  const inventory = await buildSourceInventory(sourceDir);
  await writeInventoryShards(inventory, outputPath);
  return inventory;
}

async function writeInventoryShards(
  inventory: DesignSystemSourceInventory,
  indexPath: string,
): Promise<void> {
  const rootDir = dirname(indexPath);
  const shardDir = join(rootDir, 'source-inventory');
  await mkdir(shardDir, { recursive: true });

  const index = buildInventoryIndex(inventory);
  const metadata = inventoryShardMetadata(inventory);

  await Promise.all([
    writeJson(indexPath, index),
    writeJson(join(shardDir, 'dependencies.json'), {
      ...metadata,
      dependencies: inventory.dependencies,
      assets: inventory.assets,
      scripts: inventory.scripts,
      stylesheet_references: inventory.stylesheets.map((sheet) => ({
        path: sheet.path,
        imports: sheet.imports,
        urls: sheet.urls,
        font_faces: sheet.font_faces,
      })),
    }),
    writeJson(join(shardDir, 'pages.json'), {
      ...metadata,
      pages: inventory.pages,
    }),
    writeJson(join(shardDir, 'styles.json'), {
      ...metadata,
      stylesheets: inventory.stylesheets,
    }),
    writeJson(join(shardDir, 'components.json'), {
      ...metadata,
      component_candidates: inventory.component_candidates,
    }),
    writeJson(join(shardDir, 'warnings.json'), {
      ...metadata,
      warnings: inventory.warnings,
      tree_sitter_summary: treeSitterSummary(inventory),
    }),
  ]);
}

function buildInventoryIndex(inventory: DesignSystemSourceInventory): DesignSystemSourceInventoryIndex {
  const shards: DesignSystemSourceInventoryShardMap = {
    dependencies: 'source-inventory/dependencies.json',
    pages: 'source-inventory/pages.json',
    styles: 'source-inventory/styles.json',
    components: 'source-inventory/components.json',
    warnings: 'source-inventory/warnings.json',
  };
  const topDependencies = [
    ...inventory.dependencies.css_frameworks,
    ...inventory.dependencies.icon_fonts,
    ...inventory.dependencies.js_libs,
  ].map((dep) => dep.version ? `${dep.name}@${dep.version}` : dep.name);

  return {
    inventory_version: inventory.inventory_version,
    generated_at: inventory.generated_at,
    source_root: inventory.source_root,
    totals: inventory.totals,
    shards,
    recommended_read_order: ['dependencies', 'components', 'pages', 'styles', 'warnings'],
    summary: {
      dependency_counts: {
        css_frameworks: inventory.dependencies.css_frameworks.length,
        icon_fonts: inventory.dependencies.icon_fonts.length,
        js_libs: inventory.dependencies.js_libs.length,
        fonts: inventory.dependencies.fonts.length,
        assets: inventory.assets.length,
        scripts: inventory.scripts.length,
      },
      top_dependencies: topDependencies.slice(0, 20),
      page_samples: inventory.pages.slice(0, 20).map((page) => page.path),
      component_candidate_samples: inventory.component_candidates.slice(0, 20).map((candidate) => ({
        name: candidate.name,
        category: candidate.category,
        frequency: candidate.frequency,
        confidence: candidate.confidence,
        source_refs: candidate.source_refs.slice(0, 5),
      })),
      warning_count: inventory.warnings.length,
      note: 'This is a compact index. Read shards in recommended_read_order for full evidence; original candidate HTML lives in source-inventory/components.json.',
    },
  };
}

function inventoryShardMetadata(inventory: DesignSystemSourceInventory): Pick<
  DesignSystemSourceInventory,
  'inventory_version' | 'generated_at' | 'source_root' | 'totals'
> {
  return {
    inventory_version: inventory.inventory_version,
    generated_at: inventory.generated_at,
    source_root: inventory.source_root,
    totals: inventory.totals,
  };
}

function treeSitterSummary(inventory: DesignSystemSourceInventory): {
  parsed_files: number;
  files_with_errors: number;
  languages: Record<string, number>;
} {
  const stats = [
    ...inventory.pages.map((page) => page.tree_sitter),
    ...inventory.stylesheets.map((sheet) => sheet.tree_sitter),
    ...inventory.scripts.map((script) => script.tree_sitter),
  ].filter((stat): stat is InventoryTreeSitterStats => !!stat);
  const languages: Record<string, number> = {};
  for (const stat of stats) languages[stat.language] = (languages[stat.language] ?? 0) + 1;
  return {
    parsed_files: stats.length,
    files_with_errors: stats.filter((stat) => stat.has_error).length,
    languages,
  };
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export async function buildSourceInventory(sourceDir: string): Promise<DesignSystemSourceInventory> {
  const state: AnalyzerState = {
    dependencies: {
      css_frameworks: [],
      icon_fonts: [],
      js_libs: [],
      fonts: [],
    },
    dependencyKeys: {
      css_frameworks: new Set(),
      icon_fonts: new Set(),
      js_libs: new Set(),
      fonts: new Set(),
    },
    candidates: new Map(),
    parsers: new Map(),
    warnings: [],
    classOccurrences: new Map(),
  };

  const files = await collectFiles(sourceDir);
  const pages: InventoryPage[] = [];
  const stylesheets: InventoryStylesheet[] = [];
  const scripts: InventoryScript[] = [];
  const assets: InventoryAsset[] = [];

  for (const abs of files) {
    const rel = slash(relative(sourceDir, abs));
    const ext = extname(abs).toLowerCase();
    if (ASSET_EXTENSIONS.has(ext)) {
      assets.push({ path: rel, kind: assetKind(ext) });
    }
    if (!TEXT_EXTENSIONS.has(ext)) continue;

    let content: string;
    try {
      content = await readLimitedText(abs);
    } catch (e) {
      state.warnings.push(`${rel}: ${(e as Error).message}`);
      continue;
    }

    if (ext === '.html' || ext === '.htm') {
      pages.push(await analyzeHtmlPage(rel, content, state));
    } else if (ext === '.css' || ext === '.scss' || ext === '.sass') {
      stylesheets.push(await analyzeStylesheet(rel, content, state));
    } else if (ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.ts' || ext === '.tsx' || ext === '.jsx') {
      scripts.push({
        path: rel,
        tree_sitter: await parseWithTreeSitter(rel, content, state),
      });
      detectDependenciesFromPath(rel, rel, state);
    }
  }

  const componentCandidates = Array.from(state.candidates.values())
    .map((draft) => finalizeCandidate(draft, state.classOccurrences))
    .sort((a, b) => b.confidence - a.confidence || b.frequency - a.frequency || a.name.localeCompare(b.name));

  return {
    inventory_version: INVENTORY_VERSION,
    generated_at: new Date().toISOString(),
    source_root: sourceDir,
    totals: {
      files: files.length,
      html_pages: pages.length,
      stylesheets: stylesheets.length,
      scripts: scripts.length,
      assets: assets.length,
      component_candidates: componentCandidates.length,
    },
    dependencies: state.dependencies,
    pages,
    stylesheets,
    scripts,
    assets,
    component_candidates: componentCandidates,
    warnings: state.warnings,
  };
}

async function collectFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        out.push(join(dir, entry.name));
      }
    }
  }
  await walk(root);
  out.sort();
  return out;
}

async function readLimitedText(path: string): Promise<string> {
  const buffer = await readFile(path);
  if (buffer.byteLength > MAX_TEXT_BYTES) {
    throw new Error(`file too large for inventory (${buffer.byteLength} bytes)`);
  }
  return buffer.toString('utf8');
}

async function analyzeHtmlPage(
  rel: string,
  content: string,
  state: AnalyzerState,
): Promise<InventoryPage> {
  const links = unique([...matchAttrs(content, 'link', 'href')]);
  const scripts = unique([...matchAttrs(content, 'script', 'src')]);
  const classes = unique(flatten(matchAllAttrs(content, 'class').map(splitClasses)));
  const ids = unique(matchAllAttrs(content, 'id'));
  const roles = unique(matchAllAttrs(content, 'role'));
  const dataAttrs = unique(matchDataAttributes(content));
  const pluginMarkers = unique(detectPluginMarkers(`${content}\n${links.join('\n')}\n${scripts.join('\n')}`));

  for (const link of links) detectDependenciesFromPath(link, rel, state);
  for (const script of scripts) detectDependenciesFromPath(script, rel, state);
  detectDependenciesFromClasses(classes, rel, state);
  collectCandidatesFromHtml(rel, content, state);

  return {
    path: rel,
    title: matchFirst(content, /<title[^>]*>([\s\S]*?)<\/title>/i)?.trim() ?? null,
    links,
    scripts,
    classes,
    ids,
    roles,
    data_attributes: dataAttrs,
    forms: countMatches(content, /<form\b/gi),
    tables: countMatches(content, /<table\b/gi),
    canvases: countMatches(content, /<canvas\b/gi),
    plugin_markers: pluginMarkers,
    tree_sitter: await parseWithTreeSitter(rel, content, state),
  };
}

async function analyzeStylesheet(
  rel: string,
  content: string,
  state: AnalyzerState,
): Promise<InventoryStylesheet> {
  const imports = unique([...content.matchAll(/@import\s+(?:url\()?['"]?([^'")\s;]+)['"]?\)?/gi)].map((m) => m[1]));
  const urls = unique([...content.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)].map((m) => m[1]));
  const fontFaces = extractFontFaces(content, rel);
  for (const item of [...imports, ...urls]) detectDependenciesFromPath(item, rel, state);
  for (const font of fontFaces) addFont(font, state);

  const selectors = new Set<string>();
  const classes = new Set<string>();
  const cssVariables: Record<string, string> = {};
  let parseMode: 'postcss' | 'fallback' = 'postcss';

  try {
    const root = postcss.parse(content, { from: rel });
    root.walkRules((rule) => {
      selectors.add(rule.selector);
      const line = rule.source?.start?.line ?? 0;
      for (const cls of classesFromSelector(rule.selector)) {
        classes.add(cls);
        recordClassOccurrence(state, cls, rel, line);
      }
    });
    root.walkDecls((decl) => {
      if (decl.prop.startsWith('--')) cssVariables[decl.prop] = decl.value;
    });
  } catch {
    parseMode = 'fallback';
    for (const { selector, line } of fallbackSelectorsWithLines(content)) {
      selectors.add(selector);
      for (const cls of classesFromSelector(selector)) {
        classes.add(cls);
        recordClassOccurrence(state, cls, rel, line);
      }
    }
    for (const [, name, value] of content.matchAll(/(--[-_a-zA-Z0-9]+)\s*:\s*([^;}{]+)/g)) {
      cssVariables[name] = value.trim();
    }
  }

  return {
    path: rel,
    imports,
    urls,
    selectors: Array.from(selectors).sort(),
    classes: Array.from(classes).sort(),
    css_variables: cssVariables,
    font_faces: fontFaces,
    parse_mode: parseMode,
    tree_sitter: await parseWithTreeSitter(rel, content, state),
  };
}

async function parseWithTreeSitter(
  rel: string,
  content: string,
  state: AnalyzerState,
): Promise<InventoryTreeSitterStats | undefined> {
  const ext = extname(rel).replace(/^\./, '').toLowerCase();
  const grammar = getGrammarForExtension(ext);
  if (!grammar) return undefined;
  try {
    let parser = state.parsers.get(grammar.wasmFile);
    if (!parser) {
      parser = await createParser(grammar.wasmFile);
      state.parsers.set(grammar.wasmFile, parser);
    }
    const tree = parser.parse(content);
    return {
      language: grammar.language,
      named_nodes: tree.rootNode.namedChildCount,
      has_error: tree.rootNode.hasError,
    };
  } catch (e) {
    state.warnings.push(`${rel}: tree-sitter parse skipped (${(e as Error).message})`);
    return undefined;
  }
}

function collectCandidatesFromHtml(rel: string, content: string, state: AnalyzerState): void {
  const tagRe = /<([a-zA-Z][\w:-]*)\b([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(content))) {
    const tag = match[1].toLowerCase();
    if (isVoidOrClosing(match[0])) continue;
    const attrs = match[2] ?? '';
    const classValue = attrFromString(attrs, 'class');
    const classes = splitClasses(classValue);
    if (!isCandidateTag(tag, classes, attrs)) continue;
    const html = extractElementAt(content, match.index, tag);
    if (!html) continue;
    const name = candidateName(tag, classes, attrs);
    const category = candidateCategory(tag, classes, attrs);
    const dependencyHints = detectPluginMarkers(`${classes.join(' ')} ${attrs}`);
    const sourceRef = `${rel}:${lineForIndex(content, match.index)}`;
    const key = `${name}|${tag}|${classes.filter(isStructuralClass).sort().join('.')}`;
    const existing = state.candidates.get(key);
    if (existing) {
      existing.frequency += 1;
      existing.source_refs.add(sourceRef);
      for (const dep of dependencyHints) existing.dependency_hints.add(dep);
      continue;
    }
    state.candidates.set(key, {
      key,
      name,
      suggested_kind: category === 'layout' || ['main', 'section', 'aside', 'nav'].includes(tag) ? 'page-template' : 'atom',
      category,
      tag,
      html: trimSnippet(html),
      css_classes: classes,
      source_refs: new Set([sourceRef]),
      frequency: 1,
      confidenceBase: confidenceBase(tag, classes),
      dependency_hints: new Set(dependencyHints),
    });
  }
}

function finalizeCandidate(
  candidate: CandidateDraft,
  classOccurrences: Map<string, Array<{ file: string; line: number }>>,
): InventoryComponentCandidate {
  const confidence = Math.min(
    0.98,
    candidate.confidenceBase + Math.min(0.25, candidate.frequency * 0.04) + Math.min(0.12, candidate.css_classes.length * 0.01),
  );
  const derived = deriveComponentProps(candidate, classOccurrences);
  const result: InventoryComponentCandidate = {
    name: candidate.name,
    suggested_kind: candidate.suggested_kind,
    category: candidate.category,
    tag: candidate.tag,
    html: candidate.html,
    css_classes: candidate.css_classes,
    source_refs: Array.from(candidate.source_refs).sort(),
    frequency: candidate.frequency,
    confidence: Number(confidence.toFixed(2)),
    dependency_hints: Array.from(candidate.dependency_hints).sort(),
  };
  if (Object.keys(derived).length > 0) result.derived_props = derived;
  return result;
}

const SIZE_VOCAB = new Set(['xs', 'sm', 'md', 'lg', 'xl', 'xxl']);

function recordClassOccurrence(
  state: AnalyzerState,
  cls: string,
  file: string,
  line: number,
): void {
  const list = state.classOccurrences.get(cls);
  if (list) list.push({ file, line });
  else state.classOccurrences.set(cls, [{ file, line }]);
}

function fallbackSelectorsWithLines(content: string): Array<{ selector: string; line: number }> {
  const out: Array<{ selector: string; line: number }> = [];
  const seen = new Set<string>();
  const re = /(^|})\s*([^@}{][^{}]+)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content))) {
    const selector = match[2].trim();
    if (!selector || seen.has(selector)) continue;
    seen.add(selector);
    out.push({ selector, line: lineForIndex(content, match.index) });
  }
  return out;
}

/**
 * Derive enum-style props for a component candidate from the global class
 * occurrence map.
 *
 * For each "base" class on the candidate (e.g. `btn` for a Button), we look
 * at every class in any analysed stylesheet of the form `{base}-{value}`
 * (e.g. `btn-primary`, `btn-sm`) and bucket the suffix into either:
 *   - `size`    when the suffix is in {xs, sm, md, lg, xl, xxl}
 *   - `variant` for everything else (primary, secondary, dashed, …)
 *
 * Suffixes containing hyphens (`btn-outline-primary`) are skipped to avoid
 * spurious enum entries; the extractor agent can still re-discover those as
 * compound modifiers if needed.
 */
function deriveComponentProps(
  candidate: CandidateDraft,
  classOccurrences: Map<string, Array<{ file: string; line: number }>>,
): Record<string, DerivedPropEntry> {
  const buckets: Record<string, { values: Map<string, Set<string>> }> = {};

  for (const baseClass of candidate.css_classes) {
    if (!isStructuralClass(baseClass)) continue;
    if (baseClass.includes('-')) continue;
    const prefix = `${baseClass}-`;
    for (const [cls, occ] of classOccurrences) {
      if (!cls.startsWith(prefix)) continue;
      const value = cls.slice(prefix.length);
      if (!value || value.includes('-')) continue;
      const propKey = SIZE_VOCAB.has(value) ? 'size' : 'variant';
      const bucket = (buckets[propKey] ??= { values: new Map() });
      const evidence = bucket.values.get(value) ?? new Set<string>();
      for (const o of occ) evidence.add(`${o.file}:${o.line}`);
      bucket.values.set(value, evidence);
    }
  }

  const out: Record<string, DerivedPropEntry> = {};
  for (const [propKey, bucket] of Object.entries(buckets)) {
    if (bucket.values.size < 2) continue;
    const values = Array.from(bucket.values.keys()).sort();
    const evidence = new Set<string>();
    for (const ev of bucket.values.values()) for (const e of ev) evidence.add(e);
    out[propKey] = {
      values,
      evidence: Array.from(evidence).sort().slice(0, 5),
    };
  }
  return out;
}

function detectDependenciesFromPath(value: string, source: string, state: AnalyzerState): void {
  const lower = value.toLowerCase();
  if (lower.includes('bootstrap')) addDependency('css_frameworks', 'bootstrap', versionFrom(value, /bootstrap[@/-]v?([\d.]+)/i), source, value, state);
  if (lower.includes('tailwind')) addDependency('css_frameworks', 'tailwindcss', versionFrom(value, /tailwind(?:css)?[@/-]v?([\d.]+)/i), source, value, state);
  if (lower.includes('bulma')) addDependency('css_frameworks', 'bulma', versionFrom(value, /bulma[@/-]v?([\d.]+)/i), source, value, state);

  if (lower.includes('fontawesome') || lower.includes('font-awesome') || lower.includes('kit.fontawesome')) {
    addDependency('icon_fonts', 'font-awesome', versionFrom(value, /font-?awesome[@/-]v?([\d.]+)/i), source, value, state);
  }
  if (lower.includes('bootstrap-icons')) addDependency('icon_fonts', 'bootstrap-icons', versionFrom(value, /bootstrap-icons[@/-]v?([\d.]+)/i), source, value, state);
  if (lower.includes('material-icons')) addDependency('icon_fonts', 'material-icons', null, source, value, state);
  if (lower.includes('nucleo')) addDependency('icon_fonts', 'nucleo-icons', null, source, value, state);

  const jsLibs: Array<[string, RegExp]> = [
    ['chart.js', /chart(?:js|\.js)[@/-]v?([\d.]+)/i],
    ['fullcalendar', /fullcalendar[@/-]v?([\d.]+)/i],
    ['datatables', /datatables(?:\.net)?[@/-]v?([\d.]+)/i],
    ['swiper', /swiper[@/-]v?([\d.]+)/i],
    ['choices.js', /choices(?:\.js)?[@/-]v?([\d.]+)/i],
    ['dropzone', /dropzone[@/-]v?([\d.]+)/i],
    ['flatpickr', /flatpickr[@/-]v?([\d.]+)/i],
    ['quill', /quill[@/-]v?([\d.]+)/i],
    ['sweetalert', /sweetalert2?[@/-]v?([\d.]+)/i],
    ['nouislider', /nouislider[@/-]v?([\d.]+)/i],
    ['leaflet', /leaflet[@/-]v?([\d.]+)/i],
    ['jkanban', /jkanban[@/-]v?([\d.]+)/i],
    ['dragula', /dragula[@/-]v?([\d.]+)/i],
    ['photoswipe', /photoswipe[@/-]v?([\d.]+)/i],
    ['perfect-scrollbar', /perfect-scrollbar[@/-]v?([\d.]+)/i],
    ['smooth-scrollbar', /smooth-scrollbar[@/-]v?([\d.]+)/i],
    ['countup.js', /countup(?:\.js)?[@/-]v?([\d.]+)/i],
    ['jquery', /jquery[@/-]v?([\d.]+)/i],
    ['popper.js', /popper(?:\.js)?[@/-]v?([\d.]+)/i],
  ];
  for (const [name, re] of jsLibs) {
    if (lower.includes(name.replace('.js', '')) || lower.includes(name)) {
      addDependency('js_libs', name, versionFrom(value, re), source, value, state);
    }
  }

  if (lower.includes('fonts.googleapis.com')) {
    addGoogleFont(value, state);
  }
}

function detectDependenciesFromClasses(classes: string[], source: string, state: AnalyzerState): void {
  if (classes.some((cls) => ['container', 'row', 'col', 'btn', 'card', 'navbar', 'dropdown'].includes(cls) || cls.startsWith('col-'))) {
    addDependency('css_frameworks', 'bootstrap', null, source, 'class usage', state);
  }
  if (classes.some((cls) => cls.startsWith('fa-') || cls === 'fas' || cls === 'far' || cls === 'fab')) {
    addDependency('icon_fonts', 'font-awesome', null, source, 'class usage', state);
  }
  if (classes.some((cls) => cls.startsWith('ni-') || cls === 'ni')) {
    addDependency('icon_fonts', 'nucleo-icons', null, source, 'class usage', state);
  }
}

function addDependency(
  bucket: 'css_frameworks' | 'icon_fonts' | 'js_libs',
  name: string,
  version: string | null,
  source: string,
  file: string,
  state: AnalyzerState,
): void {
  const key = `${name}|${version ?? ''}|${source}`;
  if (state.dependencyKeys[bucket].has(key)) {
    const existing = state.dependencies[bucket].find((d) => d.name === name && d.version === version && d.source === source);
    if (existing && !existing.files.includes(file)) existing.files.push(file);
    return;
  }
  state.dependencyKeys[bucket].add(key);
  state.dependencies[bucket].push({ name, version, source, files: [file] });
}

function addFont(font: InventoryFontDependency, state: AnalyzerState): void {
  const key = `${font.family}|${font.source}|${font.url ?? font.files.join(',')}`;
  if (state.dependencyKeys.fonts.has(key)) return;
  state.dependencyKeys.fonts.add(key);
  state.dependencies.fonts.push(font);
}

function addGoogleFont(url: string, state: AnalyzerState): void {
  const decoded = decodeURIComponent(url);
  const familyParam = matchFirst(decoded, /[?&]family=([^&]+)/);
  if (!familyParam) {
    addFont({ family: 'Google Font', source: 'google', url, files: [] }, state);
    return;
  }
  for (const familySpec of familyParam.split('|')) {
    const [familyRaw, weightsRaw] = familySpec.split(':');
    const family = familyRaw.replace(/\+/g, ' ').trim();
    const weights = weightsRaw
      ? unique([...weightsRaw.matchAll(/\d{3}/g)].map((m) => Number(m[0])))
      : undefined;
    addFont({ family, source: 'google', weights, url, files: [] }, state);
  }
}

function extractFontFaces(content: string, rel: string): InventoryFontDependency[] {
  const out: InventoryFontDependency[] = [];
  for (const face of content.matchAll(/@font-face\s*\{([\s\S]*?)\}/gi)) {
    const body = face[1];
    const family = matchFirst(body, /font-family\s*:\s*['"]?([^;'"]+)/i)?.trim() ?? 'self-hosted-font';
    const files = unique([...body.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)].map((m) => m[1]));
    out.push({ family, source: 'self-hosted', files: files.length > 0 ? files : [rel] });
  }
  return out;
}

function detectPluginMarkers(text: string): string[] {
  const lower = text.toLowerCase();
  const markers: string[] = [];
  const pairs: Array<[string, string[]]> = [
    ['bootstrap', ['bootstrap', 'data-bs-', 'btn ', 'navbar', 'dropdown-menu']],
    ['chart.js', ['chartjs', 'chart.js', '<canvas', 'chart-container']],
    ['fullcalendar', ['fullcalendar', 'fc-', 'calendar']],
    ['datatables', ['datatable', 'data-table', 'table-flush']],
    ['swiper', ['swiper', 'swiper-wrapper', 'swiper-slide']],
    ['choices.js', ['choices', 'data-choices']],
    ['dropzone', ['dropzone', 'data-dropzone']],
    ['flatpickr', ['flatpickr', 'data-input']],
    ['quill', ['quill', 'ql-editor']],
    ['sweetalert', ['sweetalert', 'swal']],
    ['nouislider', ['nouislider', 'no-ui-slider']],
    ['leaflet', ['leaflet', 'map']],
    ['jkanban', ['jkanban', 'kanban']],
    ['photoswipe', ['photoswipe', 'pswp']],
  ];
  for (const [name, needles] of pairs) {
    if (needles.some((needle) => lower.includes(needle))) markers.push(name);
  }
  return markers;
}

function isCandidateTag(tag: string, classes: string[], attrs: string): boolean {
  if (['nav', 'aside', 'header', 'footer', 'main', 'section', 'article', 'form', 'table'].includes(tag)) return true;
  if (tag === 'canvas') return true;
  if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea') {
    return classes.some((cls) => KNOWN_COMPONENT_CLASSES.some((known) => cls === known || cls.startsWith(`${known}-`)));
  }
  if (tag !== 'div' && tag !== 'ul' && tag !== 'ol') return false;
  if (attrs.includes('role=')) return true;
  return classes.some((cls) => KNOWN_COMPONENT_CLASSES.some((known) => cls === known || cls.startsWith(`${known}-`)));
}

function candidateName(tag: string, classes: string[], attrs: string): string {
  const classText = classes.join(' ');
  const role = attrFromString(attrs, 'role');
  if (classes.some((cls) => cls.includes('sidenav') || cls.includes('sidebar'))) return 'SidebarNavigation';
  if (classes.some((cls) => cls.includes('navbar'))) return tag === 'nav' ? 'Navbar' : 'TopNavbar';
  if (classes.some((cls) => cls.includes('breadcrumb'))) return 'Breadcrumb';
  if (classes.some((cls) => cls === 'card' || cls.startsWith('card-'))) {
    if (classText.includes('pricing')) return 'PricingCard';
    if (classText.includes('profile')) return 'ProfileCard';
    if (classText.includes('background')) return 'BackgroundCard';
    return 'Card';
  }
  if (classes.some((cls) => cls === 'btn' || cls.startsWith('btn-'))) return 'Button';
  if (classes.some((cls) => cls.includes('dropdown'))) return 'Dropdown';
  if (classes.some((cls) => cls.includes('modal'))) return 'Modal';
  if (classes.some((cls) => cls.includes('alert'))) return 'Alert';
  if (classes.some((cls) => cls.includes('badge'))) return 'Badge';
  if (classes.some((cls) => cls.includes('avatar'))) return 'Avatar';
  if (tag === 'table' || classes.some((cls) => cls.includes('table') || cls.includes('datatable'))) return 'DataTable';
  if (tag === 'form' || classes.some((cls) => cls.includes('form'))) return 'Form';
  if (tag === 'canvas' || classes.some((cls) => cls.includes('chart'))) return 'Chart';
  if (classes.some((cls) => cls.includes('swiper'))) return 'Carousel';
  if (classes.some((cls) => cls.includes('calendar'))) return 'Calendar';
  if (classes.some((cls) => cls.includes('kanban'))) return 'KanbanBoard';
  if (role) return pascalCase(role);
  return pascalCase(classes.find(isStructuralClass) ?? tag);
}

function candidateCategory(tag: string, classes: string[], attrs: string): string {
  const classText = classes.join(' ');
  if (['nav', 'aside', 'header', 'footer', 'main', 'section'].includes(tag)) return 'layout';
  if (classText.includes('navbar') || classText.includes('breadcrumb') || classText.includes('sidenav')) return 'navigation';
  if (classText.includes('card') || classText.includes('table') || tag === 'table') return 'data-display';
  if (tag === 'form' || classText.includes('form') || classText.includes('input')) return 'form';
  if (classText.includes('dropdown') || classText.includes('modal') || classText.includes('alert')) return 'overlay';
  if (attrFromString(attrs, 'role')) return 'semantic';
  return 'component';
}

function confidenceBase(tag: string, classes: string[]): number {
  if (['nav', 'aside', 'form', 'table', 'canvas'].includes(tag)) return 0.7;
  if (classes.some((cls) => KNOWN_COMPONENT_CLASSES.includes(cls))) return 0.68;
  if (classes.some((cls) => KNOWN_COMPONENT_CLASSES.some((known) => cls.startsWith(`${known}-`)))) return 0.6;
  return 0.45;
}

function extractElementAt(content: string, start: number, tag: string): string | null {
  const open = content.indexOf('>', start);
  if (open < 0) return null;
  const startTag = content.slice(start, open + 1);
  if (startTag.endsWith('/>') || ['input', 'img', 'br', 'hr', 'meta', 'link'].includes(tag)) return startTag;
  const re = new RegExp(`<\\/?${escapeRegExp(tag)}\\b[^>]*>`, 'gi');
  re.lastIndex = start;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content))) {
    const token = match[0];
    const isClose = /^<\//.test(token);
    const isSelfClosing = /\/>$/.test(token);
    if (!isClose && !isSelfClosing) depth += 1;
    if (isClose) depth -= 1;
    if (depth === 0) return content.slice(start, re.lastIndex);
    if (re.lastIndex - start > MAX_SNIPPET_CHARS) return content.slice(start, Math.min(content.length, start + MAX_SNIPPET_CHARS));
  }
  return content.slice(start, Math.min(content.length, start + MAX_SNIPPET_CHARS));
}

function matchAttrs(content: string, tag: string, attr: string): string[] {
  const out: string[] = [];
  const tagRe = new RegExp(`<${tag}\\b([^>]*)>`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(content))) {
    const value = attrFromString(match[1], attr);
    if (value) out.push(value);
  }
  return out;
}

function matchAllAttrs(content: string, attr: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${escapeRegExp(attr)}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = re.exec(content))) out.push(unquote(match[1]));
  return out;
}

function matchDataAttributes(content: string): string[] {
  const out = new Set<string>();
  for (const match of content.matchAll(/\s(data-[\w:-]+)\s*=/gi)) out.add(match[1]);
  return Array.from(out).sort();
}

function attrFromString(attrs: string, attr: string): string {
  const re = new RegExp(`\\b${escapeRegExp(attr)}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, 'i');
  const match = re.exec(attrs);
  return match ? unquote(match[1]) : '';
}

function classesFromSelector(selector: string): string[] {
  return unique([...selector.matchAll(/\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g)].map((m) => m[1]));
}

function splitClasses(value: string): string[] {
  return unique(value.split(/\s+/).map((s) => s.trim()).filter(Boolean));
}

function isStructuralClass(cls: string): boolean {
  return !/^(d|m|p|mt|mb|ms|me|mx|my|pt|pb|ps|pe|px|py|w|h|text|bg|border|shadow|rounded|align|justify)-/.test(cls);
}

function versionFrom(value: string, re: RegExp): string | null {
  return re.exec(value)?.[1] ?? null;
}

function matchFirst(content: string, re: RegExp): string | undefined {
  return re.exec(content)?.[1];
}

function countMatches(content: string, re: RegExp): number {
  return [...content.matchAll(re)].length;
}

function lineForIndex(content: string, index: number): number {
  return content.slice(0, index).split(/\r?\n/).length;
}

function trimSnippet(html: string): string {
  const compact = html.replace(/\s+\n/g, '\n').trim();
  return compact.length > MAX_SNIPPET_CHARS ? compact.slice(0, MAX_SNIPPET_CHARS) : compact;
}

function pascalCase(input: string): string {
  const words = input
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('') || 'Component';
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function flatten<T>(items: T[][]): T[] {
  return ([] as T[]).concat(...items);
}

function unquote(value: string): string {
  return value.replace(/^['"]|['"]$/g, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function slash(value: string): string {
  return value.replace(/\\/g, '/');
}

function isVoidOrClosing(tagText: string): boolean {
  return /^<\//.test(tagText) || /\/>$/.test(tagText);
}

function assetKind(ext: string): InventoryAsset['kind'] {
  if (['.woff', '.woff2', '.ttf', '.otf', '.eot'].includes(ext)) return 'font';
  if (ext === '.svg') return 'svg';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'].includes(ext)) return 'image';
  return 'other';
}
