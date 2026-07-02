/**
 * Theme digest — the deterministic bridge between a raw import/ theme and
 * the DS Studio agent. Combines the source inventory (pages, dependencies,
 * component candidates with source_refs/derived_props) with the
 * declaration-level token scan, and persists both a machine artifact
 * (`import/_analysis/theme-digest.json`) and a human/agent-readable report
 * (`import/_analysis/THEME.md`).
 *
 * The digest is regenerable at any time (scaffold, re-extract, agent tool)
 * and `_analysis/` is wiped first so stale output never feeds back in.
 */
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildSourceInventory,
  type InventoryComponentCandidate,
} from '../source-inventory.js';
import { scanCssTokens, type CssTokenScan } from './css-token-scan.js';
import { renderThemeReport } from './theme-report.js';

export const THEME_ANALYSIS_DIRNAME = '_analysis';
export const THEME_DIGEST_FILENAME = 'theme-digest.json';
export const THEME_REPORT_FILENAME = 'THEME.md';

const MAX_COMPONENTS = 40;
const MAX_PAGES = 20;

export interface ThemeDigestComponent {
  name: string;
  suggested_kind: 'atom' | 'page-template';
  category: string;
  frequency: number;
  confidence: number;
  source_refs: string[];
  derived_props?: InventoryComponentCandidate['derived_props'];
}

export interface ThemeDigest {
  digest_version: 1;
  generated_at: string;
  totals: { files: number; pages: number; stylesheets: number; components: number };
  /** Token scan over every stylesheet + inline style in the theme. */
  tokens: Omit<CssTokenScan, 'scanned_files' | 'warnings'>;
  /** Component candidates ranked by frequency×confidence, with file:line evidence. */
  components: ThemeDigestComponent[];
  pages: Array<{ path: string; title: string | null }>;
  dependencies: {
    css_frameworks: string[];
    icon_fonts: string[];
    js_libs: string[];
    fonts: string[];
  };
  warnings: string[];
}

export interface ThemeDigestSummary {
  sha256: string;
  generated_at: string;
  files: number;
  colors: number;
  components: number;
}

export async function buildThemeDigest(importDir: string): Promise<ThemeDigest> {
  const [inventory, scan] = await Promise.all([
    buildSourceInventory(importDir),
    scanCssTokens(importDir),
  ]);

  const components: ThemeDigestComponent[] = [...inventory.component_candidates]
    .sort((a, b) => b.frequency * b.confidence - a.frequency * a.confidence)
    .slice(0, MAX_COMPONENTS)
    .map((c) => ({
      name: c.name,
      suggested_kind: c.suggested_kind,
      category: c.category,
      frequency: c.frequency,
      confidence: c.confidence,
      source_refs: c.source_refs,
      ...(c.derived_props && Object.keys(c.derived_props).length > 0
        ? { derived_props: c.derived_props }
        : {}),
    }));

  const { scanned_files: _files, warnings: scanWarnings, ...tokens } = scan;
  return {
    digest_version: 1,
    generated_at: inventory.generated_at,
    totals: {
      files: inventory.totals.files,
      pages: inventory.totals.html_pages,
      stylesheets: inventory.totals.stylesheets,
      components: components.length,
    },
    tokens,
    components,
    pages: inventory.pages.slice(0, MAX_PAGES).map((p) => ({ path: p.path, title: p.title })),
    dependencies: {
      css_frameworks: inventory.dependencies.css_frameworks.map((d) => d.name),
      icon_fonts: inventory.dependencies.icon_fonts.map((d) => d.name),
      js_libs: inventory.dependencies.js_libs.map((d) => d.name),
      fonts: inventory.dependencies.fonts.map((f) => f.family),
    },
    warnings: [...inventory.warnings, ...scanWarnings],
  };
}

/**
 * Build and persist the digest under `<importDir>/_analysis/`. Returns a
 * compact summary for SSE progress / session metadata. Throws on fs errors —
 * callers decide whether that is fatal (scaffold: warn-and-continue).
 */
export async function writeThemeDigest(importDir: string): Promise<ThemeDigestSummary> {
  const analysisDir = join(importDir, THEME_ANALYSIS_DIRNAME);
  await rm(analysisDir, { recursive: true, force: true });

  const digest = await buildThemeDigest(importDir);
  const json = JSON.stringify(digest, null, 2);

  await mkdir(analysisDir, { recursive: true });
  await writeFile(join(analysisDir, THEME_DIGEST_FILENAME), json, 'utf8');
  await writeFile(join(analysisDir, THEME_REPORT_FILENAME), renderThemeReport(digest), 'utf8');

  return {
    sha256: createHash('sha256').update(json).digest('hex'),
    generated_at: digest.generated_at,
    files: digest.totals.files,
    colors: digest.tokens.colors.length,
    components: digest.components.length,
  };
}
