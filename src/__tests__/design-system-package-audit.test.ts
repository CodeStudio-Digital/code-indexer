import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  auditDesignSystemPackage,
  formatPackageAudit,
} from '@mcp/design-system/package-audit.js';
import { dsAuditPackage } from '@mcp/company/tools/design-system/ds-audit-package.js';
import { studioBinding, type DsToolBinding } from '@mcp/company/tools/design-system/binding.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

/** Strict-profile binding stub — the company host factory was retired
 *  (mig 132), but profile 'company' remains the audit's strict mode. */
const strictBinding: DsToolBinding = {
  profile: 'company',
  resolveDsSession: () => null,
  describeBinding: () => 'test-strict',
};

describe('design-system package audit and tools', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-ds-audit-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }

  function writeJson(rel: string, value: unknown): void {
    write(rel, `${JSON.stringify(value, null, 2)}\n`);
  }

  function validManifest(): Record<string, unknown> {
    return {
      manifest_version: '2',
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
      tokens: {},
      layouts: [],
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
              size: { enum: ['sm', 'lg'] },
              label: { type: 'string' },
            },
          },
          dependencies: ['bootstrap'],
          confidence: 0.93,
        },
      ],
    };
  }

  function seedCompletePackage(pkgDir = 'pkg'): string {
    const root = join(dir, pkgDir);
    writeJson(`${pkgDir}/package.json`, {
      name: '@acme/corporate-ui',
      version: '1.0.0',
      type: 'module',
      files: ['dist', 'mcp', 'storybook-static', 'docs.md', 'README.md'],
      exports: {
        '.': {
          import: './dist/index.js',
          types: './dist/index.d.ts',
        },
        './Button': {
          import: './dist/Button.js',
          types: './dist/Button.d.ts',
        },
      },
      bin: {
        'corporate-ui-mcp': './mcp/server.js',
      },
      dependencies: {
        bootstrap: '^5.3.3',
        'chart.js': '^4.4.0',
        '@fortawesome/fontawesome-free': '^6.5.0',
      },
      peerDependencies: {
        react: '^18.0.0 || ^19.0.0',
        'react-dom': '^18.0.0 || ^19.0.0',
      },
    });
    writeJson(`${pkgDir}/manifest.json`, validManifest());
    writeJson(`${pkgDir}/mcp/manifest.json`, { name: '@acme/corporate-ui', tools: [] });
    write(`${pkgDir}/mcp/server.js`, '#!/usr/bin/env node\nconsole.log("mcp");\n');
    write(`${pkgDir}/storybook-static/index.html`, '<div id="storybook-root"></div>');
    write(`${pkgDir}/docs.md`, '# Corporate UI\n');
    write(`${pkgDir}/README.md`, '# Corporate UI\n');
    write(`${pkgDir}/dist/index.js`, 'export { Button } from "../src/Button";\n');
    write(`${pkgDir}/src/Button.tsx`, `
export interface ButtonProps {
  variant?: 'primary' | 'secondary';
  size?: 'sm' | 'lg';
  label?: string;
  children?: React.ReactNode;
}

export function Button(_props: ButtonProps) {
  return null;
}
`);
    write(`${pkgDir}/src/Button.stories.tsx`, `
import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './Button';

const meta: Meta<typeof Button> = {
  component: Button,
  argTypes: {
    variant: { options: ['primary', 'secondary'], control: 'select' },
    size: { options: ['sm', 'lg'], control: 'select' },
    label: { control: 'text' },
  },
  args: {
    variant: 'primary',
    size: 'sm',
    label: 'Save',
  },
};

export default meta;

type Story = StoryObj<typeof Button>;

export const Primary: Story = { args: { variant: 'primary', label: 'Save' } };
export const Secondary: Story = { args: { variant: 'secondary', label: 'Cancel' } };
`);
    return root;
  }

  it('accepts a complete package with manifest v2, MCP, Storybook, docs and aligned React stories', async () => {
    const pkg = seedCompletePackage();

    const result = await auditDesignSystemPackage(pkg);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.details).toMatchObject({
      packageName: '@acme/corporate-ui',
      componentCount: 1,
      storyCount: 1,
      mcpManifest: true,
      storybookStatic: true,
    });
  });

  it('detects incomplete package.json#files, missing MCP bin/manifest, Storybook static output and docs', async () => {
    writeJson('pkg/package.json', {
      name: '@acme/broken-ui',
      version: '1.0.0',
      files: ['dist'],
      exports: { '.': './dist/index.js' },
      peerDependencies: { react: '^19.0.0' },
    });
    writeJson('pkg/manifest.json', validManifest());

    const result = await auditDesignSystemPackage(join(dir, 'pkg'));
    const codes = result.errors.map((issue) => issue.code);

    expect(result.ok).toBe(false);
    expect(codes).toEqual(
      expect.arrayContaining([
        'package.files_entry_missing',
        'mcp.bin_missing',
        'mcp.manifest_missing',
        'storybook.static_missing',
        'docs.aggregate_missing',
      ]),
    );
    expect(formatPackageAudit(result)).toContain('mcp.bin_missing');
  });

  it('flags audit.no_stories when the manifest declares components but no .stories.* files exist (the 649618bc template-copy failure mode)', async () => {
    const pkg = seedCompletePackage();
    // Erase every story file to simulate a build that copied a static
    // template instead of generating components with stories.
    rmSync(join(dir, 'pkg/src/Button.stories.tsx'), { force: true });

    const result = await auditDesignSystemPackage(pkg);
    const codes = result.errors.map((issue) => issue.code);

    expect(result.ok).toBe(false);
    expect(codes).toContain('audit.no_stories');
  });

  it('flags stories.insufficient_variants when a component with multi-value props has fewer than two named story exports', async () => {
    const pkg = seedCompletePackage();
    // Replace the well-formed stories file with one that has only a single
    // story export, even though Button declares variant: ['primary','secondary'].
    write('pkg/src/Button.stories.tsx', `
import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './Button';

const meta: Meta<typeof Button> = {
  component: Button,
  argTypes: {
    variant: { options: ['primary', 'secondary'], control: 'select' },
    size: { options: ['sm', 'lg'], control: 'select' },
  },
  args: { variant: 'primary', size: 'sm', label: 'Save' },
};
export default meta;

type Story = StoryObj<typeof Button>;
export const Primary: Story = { args: { variant: 'primary' } };
`);

    const result = await auditDesignSystemPackage(pkg);
    const messages = result.errors.map((issue) => issue.message).join('\n');

    expect(result.ok).toBe(false);
    expect(messages).toContain('Button has props with 2 enum values but only 1 story export');
  });

  it('flags package.exports_component_missing when a manifest component is absent from package.json#exports', async () => {
    const pkg = seedCompletePackage();
    // Strip the './Button' export, keeping only the root export.
    writeJson('pkg/package.json', {
      name: '@acme/corporate-ui',
      version: '1.0.0',
      type: 'module',
      files: ['dist', 'mcp', 'storybook-static', 'docs.md', 'README.md'],
      exports: {
        '.': { import: './dist/index.js', types: './dist/index.d.ts' },
      },
      bin: { 'corporate-ui-mcp': './mcp/server.js' },
      dependencies: { bootstrap: '^5.3.3', 'chart.js': '^4.4.0', '@fortawesome/fontawesome-free': '^6.5.0' },
      peerDependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
    });

    const result = await auditDesignSystemPackage(pkg);
    const codes = result.errors.map((issue) => issue.code);

    expect(result.ok).toBe(false);
    expect(codes).toContain('package.exports_component_missing');
  });

  it('fails on Storybook props that are absent from ButtonProps and manifest.props_schema', async () => {
    const pkg = seedCompletePackage();
    write('pkg/src/Button.stories.tsx', `
import { Button } from './Button';

export default {
  component: Button,
  argTypes: {
    variant: { options: ['primary', 'secondary', 'gradient'] },
    gradient: { options: ['purple', 'blue'] },
    iconOnly: { control: 'boolean' },
  },
  args: {
    variant: 'gradient',
    fullWidth: true,
    iconOnly: true,
  },
};
`);

    const result = await auditDesignSystemPackage(pkg);
    const messages = result.errors.map((issue) => issue.message).join('\n');

    expect(result.ok).toBe(false);
    expect(messages).toContain('argTypes.gradient is not declared on ButtonProps');
    expect(messages).toContain('argTypes.iconOnly is not declared in manifest props_schema');
    expect(messages).toContain('args.fullWidth is not declared on ButtonProps');
    expect(messages).toContain("argTypes.variant.options includes 'gradient'");
  });

  it('ds_audit_package exposes package audit failures through the native tool', async () => {
    writeJson('pkg/package.json', {
      name: '@acme/broken-ui',
      version: '1.0.0',
      files: ['dist'],
      exports: { '.': './dist/index.js' },
      peerDependencies: { react: '^19.0.0' },
    });
    writeJson('pkg/manifest.json', validManifest());

    const tool = dsAuditPackage(strictBinding);
    const result = await tool.handler(
      { pkg_dir: 'pkg' },
      { cwd: dir, projectName: 'test-project' } satisfies ToolContext,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Package audit: failed');
    expect(result.content).toContain('mcp.bin_missing');
    expect(result.content).toContain('storybook.static_missing');
  });

  it('studio profile: passes without storybook/mcp/bin but still demands docs.md', async () => {
    // Pacote mínimo do DS Studio: publica src/ direto, sem Storybook,
    // sem MCP server, sem manifest do pipeline.
    writeJson('pkg/package.json', {
      name: '@acme/studio-ds',
      version: '0.0.0',
      type: 'module',
      files: ['src', 'docs.md'],
      exports: { '.': './src/index.ts', './tokens.css': './src/tokens.css' },
      peerDependencies: { react: '^19.0.0' },
    });
    write('pkg/src/index.ts', 'export {};\n');
    write('pkg/docs.md', '# Acme DS\n');

    const passing = await auditDesignSystemPackage(join(dir, 'pkg'), { profile: 'studio' });
    expect(passing.errors).toEqual([]);
    expect(passing.ok).toBe(true);
    // Artefatos do pipeline viram warnings informativos, não bloqueio.
    expect(passing.warnings.some((w) => w.code === 'manifest.missing')).toBe(true);
    expect(passing.warnings.some((w) => w.code === 'mcp.manifest_missing')).toBe(true);

    // docs.md continua obrigatório no studio.
    rmSync(join(dir, 'pkg', 'docs.md'));
    const failing = await auditDesignSystemPackage(join(dir, 'pkg'), { profile: 'studio' });
    expect(failing.ok).toBe(false);
    expect(failing.errors.some((e) => e.code === 'docs.aggregate_missing')).toBe(true);
  });

  it('studio binding resolves the DS session by project id', () => {
    const session = { id: 9, project_id: 77, kind: 'studio' };
    const store = {
      getSessionByProjectId: (pid: number) => (pid === 77 ? session : null),
      getSessionByCompanySessionId: () => null,
    } as never;
    const binding = studioBinding(77);
    expect(binding.profile).toBe('studio');
    expect(binding.resolveDsSession(store)).toEqual(session);
    expect(binding.describeBinding()).toBe('project_id=77');
    expect(studioBinding(1).resolveDsSession(store)).toBeNull();
  });
});
