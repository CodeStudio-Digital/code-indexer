import { describe, expect, it } from 'vitest';
import {
  parsePluginManifest,
  parseAppManifest,
  parseMarketplaceManifest,
} from '@mcp/plugin-sdk';

const valid = {
  name: 'my-plugin',
  version: '1.2.3',
  description: 'Does things',
  author: { name: 'Jane' },
};

describe('parsePluginManifest', () => {
  it('accepts a minimal valid manifest', () => {
    expect(parsePluginManifest(valid).name).toBe('my-plugin');
  });

  it('rejects a non-kebab name', () => {
    expect(() => parsePluginManifest({ ...valid, name: 'My_Plugin' })).toThrow();
  });

  it('rejects a non-semver version', () => {
    expect(() => parsePluginManifest({ ...valid, version: '1.0' })).toThrow();
  });

  it('rejects a non-https websiteURL', () => {
    expect(() =>
      parsePluginManifest({
        ...valid,
        interface: { displayName: 'X', websiteURL: 'http://x.com' },
      }),
    ).toThrow();
  });

  it('rejects path traversal in a path field', () => {
    expect(() => parsePluginManifest({ ...valid, skills: '../escape' })).toThrow();
  });
});

describe('parseAppManifest', () => {
  it('accepts a declarative tool output policy', () => {
    const app = parseAppManifest({
      tools: [
        {
          name: 'query-logs',
          description: 'Queries application logs',
          parameters: { type: 'object', properties: {} },
          outputPolicy: {
            mode: 'logs',
            reducer: 'smart',
            recovery: 'output_store',
            maxInlineChars: 32_000,
            preserveOnError: true,
          },
        },
      ],
    });

    expect(app.tools?.[0].outputPolicy).toEqual({
      mode: 'logs',
      reducer: 'smart',
      recovery: 'output_store',
      maxInlineChars: 32_000,
      preserveOnError: true,
    });
  });

  it.each([
    { mode: 'unknown' },
    { mode: 'logs', reducer: 'lossy' },
    { mode: 'logs', recovery: 'magic' },
    { mode: 'logs', maxInlineChars: 0 },
    { mode: 'logs', maxInlineChars: 12.5 },
    { mode: 'logs', extra: true },
  ])('rejects an invalid tool output policy: %o', (outputPolicy) => {
    expect(() =>
      parseAppManifest({
        tools: [{ name: 'query-logs', description: 'Queries logs', outputPolicy }],
      }),
    ).toThrow();
  });

  it('accepts tool windows + commands + themes', () => {
    const app = parseAppManifest({
      toolWindows: [{ id: 'tw', title: 'TW', side: 'left', entry: 'ui/index.html' }],
      commands: [{ id: 'c', label: 'C', runsTool: 'echo' }],
      themes: [{ id: 't', label: 'T', appearance: 'dark', tokens: {} }],
      editorActions: [{ id: 'ea', label: 'EA', runsTool: 'echo', scope: 'project' }],
      statusBarItems: [{ id: 'sb', label: 'SB', alignment: 'right', runsTool: 'echo' }],
      runConfigurations: [{ id: 'run', title: 'Run', command: 'npm', args: ['test'] }],
      providerRuntime: {
        protocol: 'provider-adapter-v2',
        entry: './dist/plugin.js',
        kinds: ['acme'],
      },
      modules: [
        {
          id: 'node-project',
          title: 'Node Project',
          activation: { whenFiles: ['package.json'] },
          tools: ['echo'],
          editorActions: [{ id: 'mod-action', label: 'Mod Action', runsTool: 'echo' }],
        },
      ],
    });
    expect(app.toolWindows?.[0].side).toBe('left');
    expect(app.modules?.[0].editorActions?.[0].id).toBe('mod-action');
    expect(app.providerRuntime?.kinds).toEqual(['acme']);
  });

  it('rejects an invalid tool-window side', () => {
    expect(() =>
      parseAppManifest({
        toolWindows: [{ id: 'tw', title: 'TW', side: 'center', entry: 'x.html' }],
      }),
    ).toThrow();
  });

  it('accepts a valid permissions block', () => {
    const app = parseAppManifest({
      permissions: {
        fs: { read: ['wrangler.toml', 'src/**'], write: ['wrangler.toml'] },
        exec: { allow: ['npx', 'wrangler'] },
        storage: true,
      },
    });
    expect(app.permissions?.exec?.allow).toContain('wrangler');
    expect(app.permissions?.fs?.read).toContain('src/**');
  });

  it('rejects fs permission paths with traversal', () => {
    expect(() =>
      parseAppManifest({ permissions: { fs: { read: ['../etc/passwd'] } } }),
    ).toThrow();
  });

  it('rejects unknown permission keys (strict)', () => {
    expect(() => parseAppManifest({ permissions: { network: true } })).toThrow();
  });

  it('rejects an empty exec allow list', () => {
    expect(() => parseAppManifest({ permissions: { exec: { allow: [] } } })).toThrow();
  });
});

describe('parseMarketplaceManifest', () => {
  it('applies policy defaults', () => {
    const m = parseMarketplaceManifest({
      name: 'cat',
      plugins: [
        { name: 'p', source: { source: 'github', repo: 'a/b' }, category: 'Dev', policy: {} },
      ],
    });
    expect(m.plugins[0].policy.installation).toBe('AVAILABLE');
    expect(m.plugins[0].policy.authentication).toBe('ON_INSTALL');
  });
});
