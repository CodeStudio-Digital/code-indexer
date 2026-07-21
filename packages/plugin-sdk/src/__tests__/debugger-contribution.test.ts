import { describe, expect, it } from 'vitest';
import { appManifestSchema } from '@mcp/plugin-sdk/manifest/app-json.schema.js';
import { defineDebugAdapter } from '@mcp/plugin-sdk/debug-adapter.js';

describe('debugger contributions', () => {
  it('accepts declarative metadata and a debug-adapter-v1 runtime', () => {
    const manifest = appManifestSchema.parse({
      worker: 'dist/plugin.js',
      debuggers: [{
        id: 'javascript',
        label: 'JavaScript',
        languageIds: ['javascript', 'typescript'],
        supports: { launch: true, logpoints: true },
      }],
      debuggerRuntime: {
        protocol: 'debug-adapter-v1',
        entry: 'dist/plugin.js',
        adapters: ['javascript'],
      },
    });
    expect(manifest.debuggers?.[0].languageIds).toEqual(['javascript', 'typescript']);
    expect(manifest.debuggerRuntime?.adapters).toEqual(['javascript']);
  });

  it('rejects traversal and unknown protocols', () => {
    expect(() => appManifestSchema.parse({
      debuggerRuntime: { protocol: 'debug-adapter-v1', entry: '../adapter.js', adapters: ['javascript'] },
    })).toThrow();
    expect(() => appManifestSchema.parse({
      debuggerRuntime: { protocol: 'custom', adapters: ['javascript'] },
    })).toThrow();
  });

  it('brands an executable adapter runtime', () => {
    const adapter = defineDebugAdapter({
      id: 'test',
      resolveAdapter: () => ({ command: 'node', transport: { kind: 'stdio' } }),
      resolveConfiguration: (input) => ({ request: input.request }),
    });
    expect(adapter.sdkVersion).toBe(1);
    expect(Object.isFrozen(adapter)).toBe(true);
  });
});
