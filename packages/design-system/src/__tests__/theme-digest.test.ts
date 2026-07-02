import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanCssTokens, extractColors, guessSpacingBase } from '../theme-digest/css-token-scan.js';
import {
  buildThemeDigest,
  writeThemeDigest,
  THEME_ANALYSIS_DIRNAME,
  THEME_DIGEST_FILENAME,
  THEME_REPORT_FILENAME,
} from '../theme-digest/theme-digest.js';

const BRAND = '#1a73e8';

const APP_CSS = `
:root { --brand: ${BRAND}; }
body { font-family: 'Inter', sans-serif; color: #212529; background-color: #ffffff; font-size: 16px; margin: 16px; }
.btn { border-radius: 8px; padding: 8px 16px; font-weight: 600; }
.btn-primary { background-color: ${BRAND}; color: #ffffff; border: 1px solid ${BRAND}; }
.btn-secondary { background-color: rgb(108, 117, 125); }
.btn-lg { font-size: 20px; padding: 16px 24px; }
.btn-sm { font-size: 12px; }
.card { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15); border-radius: 8px; padding: 24px; }
a { color: hsl(214, 82%, 51%); }
@media (min-width: 768px) { .container { padding: 32px; } }
@media (min-width: 1200px) { .container { padding: 48px; } }
`;

const INDEX_HTML = `<!doctype html>
<html><head>
  <title>Corporate Home</title>
  <link rel="stylesheet" href="css/app.css">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600" rel="stylesheet">
</head><body>
  <nav class="navbar"><a href="#">Home</a></nav>
  <div class="container">
    <button class="btn btn-primary">Buy now</button>
    <button class="btn btn-secondary btn-lg">More</button>
    <button class="btn btn-primary btn-sm">Tiny</button>
    <div class="card" style="margin: 24px">A card</div>
    <div class="card">Another card</div>
  </div>
</body></html>
`;

let dir: string | null = null;

function makeThemeFixture(): string {
  dir = mkdtempSync(join(tmpdir(), 'theme-digest-'));
  mkdirSync(join(dir, 'css'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), INDEX_HTML, 'utf8');
  writeFileSync(join(dir, 'css', 'app.css'), APP_CSS, 'utf8');
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('extractColors', () => {
  it('normalizes hex, rgb() and hsl() to #rrggbb', () => {
    expect(extractColors('#ABC')).toEqual(['#aabbcc']);
    expect(extractColors('1px solid #1a73e8')).toEqual([BRAND]);
    expect(extractColors('rgb(255, 0, 0)')).toEqual(['#ff0000']);
    expect(extractColors('hsl(0, 100%, 50%)')).toEqual(['#ff0000']);
  });
});

describe('guessSpacingBase', () => {
  it('detects an 8px rhythm', () => {
    expect(guessSpacingBase([
      { value: '8px', count: 4 },
      { value: '16px', count: 6 },
      { value: '24px', count: 2 },
    ])).toBe(8);
  });
  it('returns null without a dominant base', () => {
    expect(guessSpacingBase([
      { value: '5px', count: 3 },
      { value: '7px', count: 3 },
      { value: '9px', count: 3 },
    ])).toBeNull();
  });
});

describe('scanCssTokens', () => {
  it('extracts the brand palette with roles and weights from the fixture', async () => {
    const scan = await scanCssTokens(makeThemeFixture());

    const brand = scan.colors.find((c) => c.hex === BRAND);
    expect(brand).toBeDefined();
    expect(brand!.roles).toContain('button');
    // background-color + border on .btn-primary, each weighted 3×.
    expect(brand!.count).toBeGreaterThanOrEqual(6);

    const link = scan.colors.find((c) => c.roles.includes('link'));
    expect(link).toBeDefined();

    expect(scan.fonts[0]?.value).toBe('Inter');
    expect(scan.font_weights.map((w) => w.value)).toContain('600');
    expect(scan.radii[0]?.value).toBe('8px');
    expect(scan.shadows.length).toBeGreaterThan(0);
    expect(scan.breakpoints).toEqual(['768px', '1200px']);
    expect(scan.spacing.base_px).toBe(8);
    expect(scan.css_variables['--brand']).toBe(BRAND);
  });
});

describe('buildThemeDigest', () => {
  it('merges the token scan with component candidates carrying evidence', async () => {
    const digest = await buildThemeDigest(makeThemeFixture());

    expect(digest.totals.pages).toBe(1);
    expect(digest.tokens.colors.some((c) => c.hex === BRAND)).toBe(true);

    const button = digest.components.find((c) => /btn|button/i.test(c.name));
    expect(button).toBeDefined();
    expect(button!.source_refs.some((ref) => /index\.html:\d+/.test(ref))).toBe(true);
    expect(button!.derived_props?.variant?.values).toEqual(
      expect.arrayContaining(['primary', 'secondary']),
    );
    expect(button!.derived_props?.size?.values).toEqual(expect.arrayContaining(['lg', 'sm']));

    expect(digest.pages[0]).toEqual({ path: 'index.html', title: 'Corporate Home' });
  });
});

describe('writeThemeDigest', () => {
  it('persists _analysis artifacts and is idempotent across re-runs', async () => {
    const root = makeThemeFixture();
    const summary = await writeThemeDigest(root);

    expect(summary.files).toBeGreaterThan(0);
    expect(summary.colors).toBeGreaterThan(0);
    expect(summary.components).toBeGreaterThan(0);

    const analysisDir = join(root, THEME_ANALYSIS_DIRNAME);
    expect(existsSync(join(analysisDir, THEME_DIGEST_FILENAME))).toBe(true);
    const report = readFileSync(join(analysisDir, THEME_REPORT_FILENAME), 'utf8');
    expect(report).toContain(BRAND);
    expect(report).toMatch(/index\.html:\d+/);

    // Re-run: _analysis must be wiped and rebuilt, never feeding itself
    // (same file/color/component counts — a leak would inflate them).
    const second = await writeThemeDigest(root);
    expect(second.files).toBe(summary.files);
    expect(second.colors).toBe(summary.colors);
    expect(second.components).toBe(summary.components);
  });
});
