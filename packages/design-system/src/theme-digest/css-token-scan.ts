/**
 * Declaration-level CSS scan over an import/ theme directory: colors (with
 * role hints from selector/property context), font stacks, type scale,
 * radii, shadows, spacing rhythm and breakpoints — the raw material the
 * theme digest turns into "here are THE tokens of this theme".
 *
 * postcss first, regex fallback for unparseable files (same dual-mode
 * stance as source-inventory.ts). Pure fs/string analysis, no LLM.
 */
import postcss from 'postcss';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { extractColors } from './color-normalize.js';

const MAX_FILES = 400;
const MAX_FILE_BYTES = 512 * 1024;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.cache', '_analysis']);
const CSS_EXTENSIONS = new Set(['.css', '.scss', '.less']);
const HTML_EXTENSIONS = new Set(['.html', '.htm']);

/** Properties whose color values carry design intent (weighted higher). */
const ROLE_PROPS: Record<string, string> = {
  color: 'text',
  fill: 'icon',
  stroke: 'icon',
};

export interface ScannedColor {
  hex: string;
  count: number;
  roles: string[];
}

export interface CountedValue {
  value: string;
  count: number;
}

export interface CssTokenScan {
  colors: ScannedColor[];
  fonts: CountedValue[];
  font_sizes: CountedValue[];
  font_weights: CountedValue[];
  radii: CountedValue[];
  shadows: CountedValue[];
  spacing: { base_px: number | null; values: CountedValue[] };
  breakpoints: string[];
  css_variables: Record<string, string>;
  scanned_files: number;
  warnings: string[];
}

export { extractColors } from './color-normalize.js';

function rolesFor(prop: string, selector: string): string[] {
  const roles = new Set<string>();
  const p = prop.toLowerCase();
  if (p.startsWith('background')) roles.add('background');
  else if (p.startsWith('border') || p.startsWith('outline')) roles.add('border');
  else if (ROLE_PROPS[p]) roles.add(ROLE_PROPS[p]);
  const sel = selector.toLowerCase();
  if (/\bbtn\b|button/.test(sel)) roles.add('button');
  if (/\ba\b|link/.test(sel)) roles.add('link');
  return [...roles];
}

interface Accumulator {
  colors: Map<string, { count: number; roles: Set<string> }>;
  histograms: Record<'fonts' | 'font_sizes' | 'font_weights' | 'radii' | 'shadows' | 'spacing', Map<string, number>>;
  breakpoints: Set<string>;
  cssVariables: Record<string, string>;
  warnings: string[];
  files: number;
}

function record(acc: Accumulator, selector: string, prop: string, value: string): void {
  const p = prop.toLowerCase();
  const v = value.trim();
  if (p.startsWith('--')) {
    if (!(p in acc.cssVariables)) acc.cssVariables[p] = v;
    return;
  }
  if (!v.includes('var(')) {
    // Design-intent props weigh 3× (a brand color on a button beats one buried in a gradient).
    const weight = p === 'color' || p.startsWith('background') || p.startsWith('border') || p === 'fill' || p === 'stroke' ? 3 : 1;
    for (const hex of extractColors(v)) {
      const entry = acc.colors.get(hex) ?? { count: 0, roles: new Set<string>() };
      entry.count += weight;
      for (const role of rolesFor(p, selector)) entry.roles.add(role);
      acc.colors.set(hex, entry);
    }
  }
  const bump = (key: keyof Accumulator['histograms'], val: string) => {
    const map = acc.histograms[key];
    map.set(val, (map.get(val) ?? 0) + 1);
  };
  if (p === 'font-family') bump('fonts', v.split(',')[0].trim().replace(/^['"]|['"]$/g, ''));
  else if (p === 'font-size') bump('font_sizes', v);
  else if (p === 'font-weight') bump('font_weights', v);
  else if (p === 'border-radius') bump('radii', v);
  else if (p === 'box-shadow' && v !== 'none') bump('shadows', v);
  else if (p === 'margin' || p === 'padding' || /^(margin|padding)-/.test(p)) {
    for (const part of v.split(/\s+/)) {
      if (/^[\d.]+(px|rem|em)$/.test(part) && parseFloat(part) > 0) bump('spacing', part);
    }
  }
}

const BREAKPOINT_RE = /\((min|max)-width:\s*([\d.]+(?:px|em|rem))\)/g;
const DECL_RE = /(--?[a-zA-Z][\w-]*)\s*:\s*([^;{}]+)/g;

function scanCss(acc: Accumulator, css: string): void {
  try {
    const root = postcss.parse(css);
    root.walkDecls((decl) => {
      const selector = decl.parent && 'selector' in decl.parent ? String(decl.parent.selector) : '';
      record(acc, selector, decl.prop, decl.value);
    });
    root.walkAtRules('media', (at) => {
      for (const m of at.params.matchAll(BREAKPOINT_RE)) acc.breakpoints.add(m[2]);
    });
  } catch {
    // Fallback: bare declaration regex, no selector context.
    for (const m of css.matchAll(DECL_RE)) record(acc, '', m[1], m[2]);
    for (const m of css.matchAll(BREAKPOINT_RE)) acc.breakpoints.add(m[2]);
  }
}

function scanHtml(acc: Accumulator, html: string): void {
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) scanCss(acc, m[1]);
  for (const m of html.matchAll(/style\s*=\s*"([^"]+)"/gi)) {
    for (const d of m[1].matchAll(DECL_RE)) record(acc, '', d[1], d[2]);
  }
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walkFiles(join(dir, entry.name));
    } else if (entry.isFile()) {
      yield join(dir, entry.name);
    }
  }
}

function sortedValues(map: Map<string, number>, cap = 20): CountedValue[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, cap)
    .map(([value, count]) => ({ value, count }));
}

/** Guess the spacing base unit: 8 or 4 when ≥60% of px values divide evenly. */
export function guessSpacingBase(values: CountedValue[]): number | null {
  const px = values.filter((v) => v.value.endsWith('px')).map((v) => ({ n: parseFloat(v.value), count: v.count }));
  const total = px.reduce((s, v) => s + v.count, 0);
  if (total === 0) return null;
  for (const base of [8, 4]) {
    const hits = px.filter((v) => v.n % base === 0).reduce((s, v) => s + v.count, 0);
    if (hits / total >= 0.6) return base;
  }
  return null;
}

export async function scanCssTokens(importDir: string): Promise<CssTokenScan> {
  const acc: Accumulator = {
    colors: new Map(),
    histograms: {
      fonts: new Map(), font_sizes: new Map(), font_weights: new Map(),
      radii: new Map(), shadows: new Map(), spacing: new Map(),
    },
    breakpoints: new Set(),
    cssVariables: {},
    warnings: [],
    files: 0,
  };
  for await (const path of walkFiles(importDir)) {
    if (acc.files >= MAX_FILES) {
      acc.warnings.push(`File cap reached (${MAX_FILES}) — scan truncated.`);
      break;
    }
    const ext = extname(path).toLowerCase();
    const isCss = CSS_EXTENSIONS.has(ext);
    if (!isCss && !HTML_EXTENSIONS.has(ext)) continue;
    acc.files += 1;
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (e) {
      acc.warnings.push(`Unreadable file skipped: ${path} (${(e as Error).message})`);
      continue;
    }
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
      acc.warnings.push(`Oversized file skipped: ${path}`);
      continue;
    }
    if (isCss) scanCss(acc, text);
    else scanHtml(acc, text);
  }

  const spacingValues = sortedValues(acc.histograms.spacing);
  return {
    colors: [...acc.colors.entries()]
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .slice(0, 25)
      .map(([hex, { count, roles }]) => ({ hex, count, roles: [...roles].sort() })),
    fonts: sortedValues(acc.histograms.fonts, 10),
    font_sizes: sortedValues(acc.histograms.font_sizes),
    font_weights: sortedValues(acc.histograms.font_weights, 10),
    radii: sortedValues(acc.histograms.radii, 10),
    shadows: sortedValues(acc.histograms.shadows, 8),
    spacing: { base_px: guessSpacingBase(spacingValues), values: spacingValues },
    breakpoints: [...acc.breakpoints].sort((a, b) => parseFloat(a) - parseFloat(b)),
    css_variables: acc.cssVariables,
    scanned_files: acc.files,
    warnings: acc.warnings,
  };
}
