import { describe, it, expect } from 'vitest';
import {
  formatManifestValidation,
  validateDesignSystemManifestData,
} from '@mcp/design-system/manifest-schema.js';

function validManifest(): Record<string, unknown> {
  return {
    manifest_version: '2',
    name: 'Corporate UI',
    source_inventory_path: './source-inventory.json',
    dependencies: {
      css_frameworks: [
        { name: 'bootstrap', version: '5.3.3', source: 'index.html', files: ['assets/bootstrap.css'] },
      ],
      icon_fonts: [
        { name: 'font-awesome', version: null, source: 'index.html', files: ['assets/fa.css'] },
      ],
      js_libs: [
        { name: 'chart.js', version: null, source: 'dashboard.html', files: ['assets/chart.umd.js'] },
      ],
      fonts: [
        { family: 'Inter', source: 'google', weights: [400, 700], url: 'https://fonts.googleapis.com/css2?family=Inter', files: [] },
      ],
    },
    tokens: {
      colors: { primary: '#9c27b0' },
    },
    layouts: [
      {
        name: 'DashboardShell',
        html: '<main class="dashboard-page"><aside class="sidenav"></aside></main>',
        css_classes: ['dashboard-page', 'sidenav'],
        source_refs: [{ file: 'dashboard.html', line: 10, selector: '.dashboard-page' }],
        confidence: 0.8,
      },
    ],
    components: [
      {
        name: 'Button',
        kind: 'atom',
        html: '<button class="btn btn-primary">Save</button>',
        css_classes: ['btn', 'btn-primary'],
        source_refs: ['index.html:42'],
        props_schema: {
          properties: {
            variant: { enum: ['primary', 'secondary'] },
            label: { type: 'string' },
          },
        },
        dependencies: ['bootstrap'],
        confidence: 0.92,
      },
    ],
  };
}

describe('DesignSystemManifestV2 schema', () => {
  it('accepts a complete v2 manifest with normalized dependency buckets', () => {
    const result = validateDesignSystemManifestData(validManifest(), { strict: true });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.manifest?.manifest_version).toBe('2');
    expect(result.manifest?.dependencies.css_frameworks[0]?.name).toBe('bootstrap');
    expect(formatManifestValidation(result)).toBe('Manifest is valid.');
  });

  it('rejects shallow components without html, kind or props_schema', () => {
    const manifest = validManifest();
    manifest.components = [
      {
        name: 'Button',
        css_classes: ['btn'],
        source_refs: ['index.html:42'],
        dependencies: ['bootstrap'],
        confidence: 0.7,
      },
    ];

    const result = validateDesignSystemManifestData(manifest, { strict: true });
    const paths = result.errors.map((issue) => issue.path);

    expect(result.ok).toBe(false);
    expect(paths).toEqual(
      expect.arrayContaining(['components.0.kind', 'components.0.html', 'components.0.props_schema']),
    );
    expect(formatManifestValidation(result)).toContain('components.0.html');
  });

  it('rejects legacy free-form dependency objects', () => {
    const manifest = validManifest();
    manifest.dependencies = {
      bootstrap: true,
      chartjs: 'cdn',
    };

    const result = validateDesignSystemManifestData(manifest, { strict: true });

    expect(result.ok).toBe(false);
    expect(result.errors.some((issue) => issue.path === 'dependencies')).toBe(true);
    expect(formatManifestValidation(result)).toMatch(/Unrecognized key/);
  });

  it('rejects duplicate component names and warns when declared classes do not appear in html', () => {
    const manifest = validManifest();
    const components = manifest.components as Record<string, unknown>[];
    components.push({
      ...components[0],
      html: '<button class="btn">Cancel</button>',
      css_classes: ['missing-class'],
    });

    const result = validateDesignSystemManifestData(manifest, { strict: true });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'components.1.name', message: "duplicate component name 'Button'" }),
      ]),
    );
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'components.1.css_classes' }),
      ]),
    );
  });
});
