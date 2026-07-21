import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadDebugAdapter, type DebuggerPluginRef } from '../debugger-loader.js';

const runtimeFile = fileURLToPath(new URL('./fixtures/debugger-runtime/dist/plugin.mjs', import.meta.url));

function ref(source: string): DebuggerPluginRef {
  return {
    namespace: 'javascript-debugger',
    source,
    debuggers: [{ id: 'javascript', label: 'JavaScript', languageIds: ['javascript'] }],
    runtime: { file: runtimeFile, adapters: ['javascript'] },
  };
}

describe('debugger loader', () => {
  it('loads a valid bundled first-party runtime', async () => {
    const loaded = await loadDebugAdapter('javascript', { refs: [ref('bundled')] });
    expect(loaded.namespace).toBe('javascript-debugger');
    expect(loaded.runtime.sdkVersion).toBe(1);
    expect(loaded.runtime.id).toBe('javascript');
  });

  it('refuses executable runtimes from non-bundled plugins', async () => {
    await expect(loadDebugAdapter('javascript', { refs: [ref('local')] })).rejects.toThrow(
      'not a trusted bundled runtime',
    );
  });

  it('requires manifest ownership of the requested adapter', async () => {
    const value = ref('bundled');
    value.runtime = { ...value.runtime!, adapters: ['other'] };
    await expect(loadDebugAdapter('javascript', { refs: [value] })).rejects.toThrow(
      "does not own executable adapter 'javascript'",
    );
  });
});
