import { describe, expect, it } from 'vitest';
import { loadedExtensionsForRuntimeId } from '../php-manager.js';

describe('loadedExtensionsForRuntimeId', () => {
  it('does not inspect system or unmanaged PHP selections', () => {
    expect(loadedExtensionsForRuntimeId(undefined, 'D:/missing')).toEqual([]);
    expect(loadedExtensionsForRuntimeId('system', 'D:/missing')).toEqual([]);
    expect(loadedExtensionsForRuntimeId('homebrew:8.3.7', 'D:/missing')).toEqual([]);
  });

  it('rejects an invalid persisted managed id without escaping the runtime root', () => {
    expect(loadedExtensionsForRuntimeId('managed:../../outside', 'D:/missing')).toEqual([]);
  });
});
