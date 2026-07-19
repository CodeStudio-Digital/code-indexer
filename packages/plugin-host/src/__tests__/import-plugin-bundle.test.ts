import { afterEach, describe, expect, it } from 'vitest';
import { importPluginBundle } from '../import-plugin-bundle.js';

const originalSourceMapsEnabled = process.sourceMapsEnabled;

afterEach(() => {
  process.setSourceMapsEnabled(originalSourceMapsEnabled !== false);
});

describe('importPluginBundle', () => {
  it('suppresses loader-generated source maps until concurrent imports settle', async () => {
    process.setSourceMapsEnabled(true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const observed: boolean[] = [];
    const importer = async () => {
      observed.push(process.sourceMapsEnabled);
      await gate;
      return { ok: true };
    };

    const first = importPluginBundle('C:\\plugins\\first.js', importer);
    const second = importPluginBundle('C:\\plugins\\second.js', importer);

    expect(process.sourceMapsEnabled).toBe(false);
    expect(observed).toEqual([false, false]);
    release();
    await Promise.all([first, second]);
    expect(process.sourceMapsEnabled).toBe(true);
  });

  it('restores the previous setting when an import fails', async () => {
    process.setSourceMapsEnabled(true);

    await expect(importPluginBundle('C:\\plugins\\broken.js', async () => {
      expect(process.sourceMapsEnabled).toBe(false);
      throw new Error('broken plugin');
    })).rejects.toThrow('broken plugin');

    expect(process.sourceMapsEnabled).toBe(true);
  });
});
