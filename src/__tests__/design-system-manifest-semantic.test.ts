import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateDesignSystemManifestFile,
  validateManifestSemantic,
  type DesignSystemManifestV2,
} from '@mcp/design-system/manifest-schema.js';

describe('manifest semantic validation', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-ds-semantic-'));
    mkdirSync(join(dir, 'source-inventory'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeShard(name: string, data: unknown): void {
    writeFileSync(
      join(dir, 'source-inventory', `${name}.json`),
      JSON.stringify(data, null, 2),
    );
  }

  function writeManifest(manifest: unknown): string {
    const path = join(dir, 'manifest.json');
    writeFileSync(path, JSON.stringify(manifest, null, 2));
    return path;
  }

  function bootstrapStylesShard() {
    return {
      stylesheets: [
        {
          path: 'assets/bootstrap.css',
          selectors: ['.btn', '.btn-primary', '.btn-secondary', '.btn-success', '.btn-danger', '.card'],
          classes: ['btn', 'btn-primary', 'btn-secondary', 'btn-success', 'btn-danger', 'card'],
          css_variables: { '--bs-primary': '#0d6efd' },
        },
      ],
    };
  }

  function bootstrapDependenciesShard() {
    return {
      dependencies: {
        css_frameworks: [{ name: 'bootstrap', version: '5.3.3', source: 'index.html', files: ['assets/bootstrap.css'] }],
      },
    };
  }

  function buildManifest(props: Record<string, unknown>): DesignSystemManifestV2 {
    return {
      manifest_version: '2',
      dependencies: {
        css_frameworks: [
          { name: 'bootstrap', version: '5.3.3', source: 'index.html', files: ['assets/bootstrap.css'] },
        ],
        icon_fonts: [],
        js_libs: [],
        fonts: [],
      },
      tokens: {},
      layouts: [],
      components: [
        {
          name: 'Button',
          kind: 'atom',
          html: '<button class="btn btn-primary">Save</button>',
          css_classes: ['btn', 'btn-primary'],
          source_refs: ['index.html:42'],
          props_schema: props,
          dependencies: ['bootstrap'],
          confidence: 0.9,
        },
      ],
    } as DesignSystemManifestV2;
  }

  it('accepts a Bootstrap Button whose variant values match .btn-* classes', async () => {
    writeShard('styles', bootstrapStylesShard());
    writeShard('dependencies', bootstrapDependenciesShard());
    const manifest = buildManifest({
      variant: { values: ['primary', 'secondary', 'success', 'danger'] },
    });

    const result = await validateManifestSemantic(manifest, {
      sourceInventoryDir: join(dir, 'source-inventory'),
    });

    expect(result.errors).toEqual([]);
  });

  it('rejects Material UI vocab leaked into a Bootstrap manifest (Button v1.2.2 incident)', async () => {
    writeShard('styles', bootstrapStylesShard());
    writeShard('dependencies', bootstrapDependenciesShard());
    const manifest = buildManifest({
      variant: { values: ['contained', 'outlined', 'text'] },
    });

    const result = await validateManifestSemantic(manifest, {
      sourceInventoryDir: join(dir, 'source-inventory'),
    });

    expect(result.errors.length).toBeGreaterThanOrEqual(3);
    expect(result.errors.every((e) => e.code === 'vocab.leak')).toBe(true);
    expect(result.errors.some((e) => e.message.includes("'contained'"))).toBe(true);
    expect(result.errors.some((e) => e.message.includes('material-ui'))).toBe(true);
  });

  it('reports props.foreign_vocabulary for unknown values that are not a recognized leak', async () => {
    writeShard('styles', bootstrapStylesShard());
    writeShard('dependencies', bootstrapDependenciesShard());
    const manifest = buildManifest({
      variant: { values: ['xenon'] },
    });

    const result = await validateManifestSemantic(manifest, {
      sourceInventoryDir: join(dir, 'source-inventory'),
    });

    expect(result.errors.length).toBe(1);
    expect(result.errors[0].code).toBe('props.foreign_vocabulary');
    expect(result.errors[0].message).toContain('xenon');
  });

  it('reports css.dangling_in_styles when a component declares a class missing from any stylesheet', async () => {
    writeShard('styles', bootstrapStylesShard());
    writeShard('dependencies', bootstrapDependenciesShard());
    const manifest = buildManifest({
      variant: { values: ['primary'] },
    });
    manifest.components[0].css_classes = ['btn', 'btn-primary', 'btn-mythical'];

    const result = await validateManifestSemantic(manifest, {
      sourceInventoryDir: join(dir, 'source-inventory'),
    });

    expect(result.errors.some((e) => e.code === 'css.dangling_in_styles' && e.message.includes('btn-mythical'))).toBe(true);
  });

  it('skips semantic checks gracefully when no shards exist', async () => {
    const manifest = buildManifest({ variant: { values: ['contained'] } });

    const result = await validateManifestSemantic(manifest, {
      sourceInventoryDir: join(dir, 'source-inventory'),
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toBe('semantic.shards_missing');
  });

  it('supports JSON-schema-style props_schema with nested properties', async () => {
    writeShard('styles', bootstrapStylesShard());
    writeShard('dependencies', bootstrapDependenciesShard());
    const manifest = buildManifest({
      properties: {
        variant: { enum: ['contained', 'outlined'] },
        label: { type: 'string' },
      },
    });

    const result = await validateManifestSemantic(manifest, {
      sourceInventoryDir: join(dir, 'source-inventory'),
    });

    expect(result.errors.length).toBe(2);
    expect(result.errors.every((e) => e.code === 'vocab.leak')).toBe(true);
  });

  it('validateDesignSystemManifestFile auto-resolves source-inventory beside the manifest', async () => {
    writeShard('styles', bootstrapStylesShard());
    writeShard('dependencies', bootstrapDependenciesShard());
    const path = writeManifest(buildManifest({ variant: { values: ['contained'] } }));

    const result = await validateDesignSystemManifestFile(path, { strict: true });

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'vocab.leak')).toBe(true);
  });

  it('validateDesignSystemManifestFile honors semantic: false to skip cross-checks', async () => {
    writeShard('styles', bootstrapStylesShard());
    writeShard('dependencies', bootstrapDependenciesShard());
    const path = writeManifest(buildManifest({ variant: { values: ['contained'] } }));

    const result = await validateDesignSystemManifestFile(path, { strict: true, semantic: false });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('does not flag vocab as leak when the source actually depends on the matching framework', async () => {
    writeShard('styles', {
      stylesheets: [
        { path: 'mui.css', selectors: ['.MuiButton-contained', '.MuiButton-outlined'], classes: ['MuiButton-contained', 'MuiButton-outlined'] },
      ],
    });
    writeShard('dependencies', {
      dependencies: {
        css_frameworks: [{ name: 'material-ui', version: '5.0.0', source: 'index.html', files: ['mui.css'] }],
      },
    });
    const manifest = buildManifest({ variant: { values: ['contained', 'outlined'] } });
    manifest.dependencies.css_frameworks = [
      { name: 'material-ui', version: '5.0.0', source: 'index.html', files: ['mui.css'] },
    ];
    manifest.components[0].css_classes = ['MuiButton-contained'];

    const result = await validateManifestSemantic(manifest, {
      sourceInventoryDir: join(dir, 'source-inventory'),
    });

    expect(result.errors.filter((e) => e.code === 'vocab.leak')).toEqual([]);
  });
});
