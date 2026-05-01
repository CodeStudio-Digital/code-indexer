import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildSourceInventory,
  writeSourceInventory,
} from '../core/design-system/source-inventory.js';

describe('design-system source inventory', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-ds-inventory-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, content: string | Buffer): void {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  function readJson<T>(path: string): T {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  }

  it('detects dependencies, assets, page structures, CSS classes and component candidates', async () => {
    write('index.html', `<!doctype html>
<html>
  <head>
    <title>Corporate UI</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap">
    <link rel="stylesheet" href="assets/vendor/bootstrap.min.css">
    <link rel="stylesheet" href="assets/vendor/fontawesome/css/all.min.css">
    <link rel="stylesheet" href="assets/css/app.css">
  </head>
  <body>
    <nav class="navbar navbar-expand-lg bg-white" role="navigation">
      <a class="btn btn-primary" data-bs-toggle="dropdown" href="#">Open</a>
    </nav>
    <section class="container">
      <div class="card pricing-card" data-plan="pro">
        <div class="card-header"><h2>Pro</h2></div>
        <div class="card-body"><span class="badge badge-success">Popular</span></div>
      </div>
      <form class="form login-form" data-validate="true">
        <input class="form-control" name="email" />
      </form>
      <table id="orders" class="table datatable" data-datatable="true">
        <tr><td>#100</td></tr>
      </table>
      <canvas id="salesChart" class="chart-canvas"></canvas>
      <div class="swiper"><div class="swiper-wrapper"><div class="swiper-slide">A</div></div></div>
      <div id="editor" class="ql-editor"></div>
    </section>
    <script src="assets/vendor/chart.umd.js"></script>
    <script src="assets/vendor/fullcalendar.min.js"></script>
    <script src="assets/vendor/jquery.dataTables.min.js"></script>
    <script src="assets/vendor/swiper-bundle.min.js"></script>
    <script src="assets/vendor/quill.min.js"></script>
    <script src="assets/js/app.js"></script>
  </body>
</html>`);
    write('dashboard.html', '<div class="card pricing-card"><div class="card-body">Again</div></div>');
    write('assets/css/app.css', `
@import url("../vendor/datatables.css");
@font-face {
  font-family: "Acme Icons";
  src: url("../fonts/acme.woff2") format("woff2");
}
:root { --brand-primary: #9c27b0; }
.card { border-radius: 8px; }
.pricing-card .btn { color: var(--brand-primary); }
.chart-canvas { min-height: 240px; }
`);
    write('assets/scss/theme.scss', `
$primary: #9c27b0;
.dashboard-card {
  &__title { color: $primary; }
}
`);
    write('assets/js/app.js', 'const chart = new Chart(document.getElementById("salesChart"), {});');
    write('assets/img/logo.png', Buffer.from([1, 2, 3]));
    write('assets/fonts/acme.woff2', Buffer.from([4, 5, 6]));

    const inventory = await buildSourceInventory(dir);

    expect(inventory.totals.html_pages).toBe(2);
    expect(inventory.totals.stylesheets).toBe(2);
    expect(inventory.assets.map((asset) => asset.path)).toEqual(
      expect.arrayContaining(['assets/img/logo.png', 'assets/fonts/acme.woff2']),
    );

    expect(inventory.dependencies.css_frameworks.map((dep) => dep.name)).toContain('bootstrap');
    expect(inventory.dependencies.icon_fonts.map((dep) => dep.name)).toContain('font-awesome');
    expect(inventory.dependencies.js_libs.map((dep) => dep.name)).toEqual(
      expect.arrayContaining(['chart.js', 'fullcalendar', 'datatables', 'swiper', 'quill']),
    );
    expect(inventory.dependencies.fonts.map((font) => font.family)).toEqual(
      expect.arrayContaining(['Inter', 'Acme Icons']),
    );

    const index = inventory.pages.find((page) => page.path === 'index.html');
    expect(index?.classes).toEqual(expect.arrayContaining(['card', 'pricing-card', 'datatable', 'ql-editor']));
    expect(index?.ids).toEqual(expect.arrayContaining(['orders', 'salesChart', 'editor']));
    expect(index?.roles).toContain('navigation');
    expect(index?.data_attributes).toEqual(expect.arrayContaining(['data-plan', 'data-validate', 'data-datatable']));
    expect(index?.forms).toBe(1);
    expect(index?.tables).toBe(1);
    expect(index?.canvases).toBe(1);
    expect(index?.plugin_markers).toEqual(
      expect.arrayContaining(['bootstrap', 'chart.js', 'datatables', 'swiper', 'quill']),
    );
    expect(index?.tree_sitter?.language).toBe('html');

    const css = inventory.stylesheets.find((sheet) => sheet.path === 'assets/css/app.css');
    expect(css?.classes).toEqual(expect.arrayContaining(['card', 'pricing-card', 'chart-canvas']));
    expect(css?.css_variables['--brand-primary']).toBe('#9c27b0');
    expect(css?.font_faces[0]?.family).toBe('Acme Icons');

    const scss = inventory.stylesheets.find((sheet) => sheet.path === 'assets/scss/theme.scss');
    expect(scss?.classes).toContain('dashboard-card');

    const candidateNames = inventory.component_candidates.map((candidate) => candidate.name);
    expect(candidateNames).toEqual(
      expect.arrayContaining(['Navbar', 'Card', 'Button', 'Form', 'DataTable', 'Chart', 'Carousel']),
    );
    const card = inventory.component_candidates.find((candidate) => candidate.html.includes('pricing-card'));
    expect(card?.name).toBe('PricingCard');
    expect(card?.source_refs.some((ref) => ref.startsWith('dashboard.html:'))).toBe(true);
    expect(card?.source_refs.some((ref) => ref.startsWith('index.html:'))).toBe(true);
    expect(card?.frequency).toBe(2);
    expect(card?.confidence).toBeGreaterThan(0.7);
  });

  it('derives variant and size props from CSS rules of the form .{base}-{value}', async () => {
    write('index.html', `<!doctype html>
<html><head><link rel="stylesheet" href="theme.css"></head>
<body>
  <button class="btn">Save</button>
  <button class="btn">Cancel</button>
</body></html>`);
    write('theme.css', `
.btn { padding: 8px; }
.btn-primary { color: white; background: #0d6efd; }
.btn-secondary { color: white; background: #6c757d; }
.btn-success { background: #198754; }
.btn-danger { background: #dc3545; }
.btn-sm { padding: 4px; }
.btn-lg { padding: 12px; }
.btn-outline-primary { border: 1px solid #0d6efd; }
`);

    const inventory = await buildSourceInventory(dir);
    const button = inventory.component_candidates.find((c) => c.name === 'Button');

    expect(button).toBeDefined();
    expect(button?.derived_props).toBeDefined();
    expect(button?.derived_props?.variant?.values).toEqual(
      expect.arrayContaining(['primary', 'secondary', 'success', 'danger']),
    );
    // The compound 'outline-primary' is intentionally skipped (hyphen in value)
    expect(button?.derived_props?.variant?.values).not.toContain('outline-primary');
    expect(button?.derived_props?.size?.values).toEqual(expect.arrayContaining(['sm', 'lg']));
    // Evidence should reference theme.css with a real line number
    expect(button?.derived_props?.variant?.evidence?.[0]).toMatch(/^theme\.css:\d+$/);
  });

  it('omits derived_props when fewer than two enum values are observed', async () => {
    write('index.html', '<button class="btn">Only</button>');
    write('theme.css', '.btn { padding: 8px; } .btn-primary { color: red; }');

    const inventory = await buildSourceInventory(dir);
    const button = inventory.component_candidates.find((c) => c.name === 'Button');

    expect(button?.derived_props).toBeUndefined();
  });

  it('does NOT derive props for compound base classes that contain a hyphen', async () => {
    // Regression: previously a candidate with css_classes ['pricing-card'] could
    // wrongly extract derived_props from `.pricing-card-foo` rules; only
    // structural roots like `card` are valid bases for derivation.
    write('index.html', '<div class="pricing-card"><h2>Pro</h2></div>');
    write('theme.css', '.pricing-card-foo { color: red; }');

    const inventory = await buildSourceInventory(dir);
    const candidate = inventory.component_candidates.find((c) => c.name === 'PricingCard');

    expect(candidate?.derived_props).toBeUndefined();
  });

  it('writes source-inventory.json for extraction and re-extraction flows', async () => {
    const source = join(dir, 'design_system');
    mkdirSync(source, { recursive: true });
    mkdirSync(join(source, 'assets'), { recursive: true });
    writeFileSync(join(source, 'index.html'), `
<link rel="stylesheet" href="assets/bootstrap.css">
<div class="card"><div class="card-body">Hello</div></div>
<script src="assets/chart.umd.js"></script>
`);
    writeFileSync(join(source, 'assets', 'bootstrap.css'), '.card{display:block}:root{--brand:#9c27b0}');
    writeFileSync(join(source, 'assets', 'chart.umd.js'), 'window.Chart = function Chart() {};');

    const output = join(dir, 'source-inventory.json');
    const inventory = await writeSourceInventory(source, output);

    expect(inventory.totals.html_pages).toBe(1);
    expect(existsSync(output)).toBe(true);
    const persisted = readJson<{
      totals: { html_pages: number };
      shards: Record<string, string>;
      recommended_read_order: string[];
      component_candidates?: unknown;
    }>(output);
    expect(persisted.totals.html_pages).toBe(1);
    expect(persisted.component_candidates).toBeUndefined();
    expect(persisted.shards).toEqual({
      dependencies: 'source-inventory/dependencies.json',
      pages: 'source-inventory/pages.json',
      styles: 'source-inventory/styles.json',
      components: 'source-inventory/components.json',
      warnings: 'source-inventory/warnings.json',
    });
    expect(persisted.recommended_read_order).toEqual(['dependencies', 'components', 'pages', 'styles', 'warnings']);

    const dependencies = readJson<{
      dependencies: { css_frameworks: Array<{ name: string }>; js_libs: Array<{ name: string }> };
      scripts: Array<{ path: string }>;
      stylesheet_references: Array<{ path: string }>;
    }>(join(dir, 'source-inventory', 'dependencies.json'));
    expect(dependencies.dependencies.css_frameworks.map((dep) => dep.name)).toContain('bootstrap');
    expect(dependencies.dependencies.js_libs.map((dep) => dep.name)).toContain('chart.js');
    expect(dependencies.scripts.map((script) => script.path)).toContain('assets/chart.umd.js');
    expect(dependencies.stylesheet_references.map((sheet) => sheet.path)).toContain('assets/bootstrap.css');

    const pages = readJson<{ pages: Array<{ path: string; classes: string[] }> }>(join(dir, 'source-inventory', 'pages.json'));
    expect(pages.pages[0]?.path).toBe('index.html');
    expect(pages.pages[0]?.classes).toContain('card');

    const styles = readJson<{ stylesheets: Array<{ path: string; classes: string[]; css_variables: Record<string, string> }> }>(join(dir, 'source-inventory', 'styles.json'));
    expect(styles.stylesheets[0]?.path).toBe('assets/bootstrap.css');
    expect(styles.stylesheets[0]?.classes).toContain('card');
    expect(styles.stylesheets[0]?.css_variables['--brand']).toBe('#9c27b0');

    const components = readJson<{ component_candidates: Array<{ name: string; html: string }> }>(join(dir, 'source-inventory', 'components.json'));
    expect(components.component_candidates[0]?.name).toBe('Card');
    expect(components.component_candidates[0]?.html).toContain('card-body');

    const warnings = readJson<{ warnings: string[]; tree_sitter_summary: { parsed_files: number } }>(join(dir, 'source-inventory', 'warnings.json'));
    expect(warnings.warnings).toEqual(expect.any(Array));
    expect(warnings.tree_sitter_summary.parsed_files).toBeGreaterThan(0);
  });

  it('keeps large corporate-style templates from collapsing into a tiny vague manifest', async () => {
    write('assets/vendor/bootstrap.min.css', '.card{display:block}.navbar{display:flex}.table{width:100%}');
    write('assets/vendor/chart.umd.js', 'window.Chart = function Chart() {};');

    for (let i = 1; i <= 55; i++) {
      write(`pages/page-${i}.html`, `<!doctype html>
<html>
  <head>
    <link rel="stylesheet" href="../assets/vendor/bootstrap.min.css">
  </head>
  <body>
    <nav class="navbar navbar-expand-lg"><a class="btn btn-primary" href="#">Page ${i}</a></nav>
    <main class="container dashboard-page">
      <div class="card card-stats"><div class="card-body">Metric ${i}</div></div>
      <table class="table datatable"><tr><td>${i}</td></tr></table>
      <form class="form filter-form"><input class="form-control" name="q" /></form>
      <canvas class="chart-canvas" data-chart="line"></canvas>
    </main>
    <script src="../assets/vendor/chart.umd.js"></script>
  </body>
</html>`);
    }

    const inventory = await buildSourceInventory(dir);
    const names = inventory.component_candidates.map((candidate) => candidate.name);

    expect(inventory.totals.html_pages).toBe(55);
    expect(inventory.dependencies.css_frameworks.map((dep) => dep.name)).toContain('bootstrap');
    expect(inventory.dependencies.js_libs.map((dep) => dep.name)).toContain('chart.js');
    expect(names).toEqual(expect.arrayContaining(['Navbar', 'Card', 'DataTable', 'Form', 'Chart']));
    expect(inventory.component_candidates.length).toBeGreaterThanOrEqual(5);

    const card = inventory.component_candidates.find((candidate) => candidate.css_classes.includes('card-stats'));
    expect(card?.frequency).toBe(55);
    expect(card?.source_refs.length).toBe(55);

    const output = join(dir, 'source-inventory.json');
    await writeSourceInventory(dir, output);
    const indexText = readFileSync(output, 'utf8');
    const componentsText = readFileSync(join(dir, 'source-inventory', 'components.json'), 'utf8');
    const index = JSON.parse(indexText) as { component_candidates?: unknown; shards: Record<string, string> };

    expect(index.component_candidates).toBeUndefined();
    expect(index.shards.components).toBe('source-inventory/components.json');
    expect(indexText).not.toContain('card-stats');
    expect(componentsText).toContain('card-stats');
    expect(indexText.length).toBeLessThan(componentsText.length);
  });
});
