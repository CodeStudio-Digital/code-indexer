import { describe, it, expect } from 'vitest';
import { join, resolve, sep } from 'node:path';
import { resolveStorageBindPath } from '../core/verdaccio/storage-paths.js';

describe('resolveStorageBindPath', () => {
  it('defaults to <cwd>/data/packages alongside virtual-projects + design-system-uploads', () => {
    const r = resolveStorageBindPath({ cwd: 'D:\\MCP', override: null });
    expect(r).toBe(resolve(join('D:\\MCP', 'data', 'packages')));
  });

  it('uses MCP_VERDACCIO_STORAGE_DIR override when supplied', () => {
    const override = '/mnt/registry-backups/packages';
    const r = resolveStorageBindPath({ cwd: '/anywhere', override });
    expect(r).toBe(resolve(override));
  });

  it('treats empty / whitespace override as unset', () => {
    expect(resolveStorageBindPath({ cwd: '/x', override: '' })).toBe(resolve('/x', 'data', 'packages'));
    expect(resolveStorageBindPath({ cwd: '/x', override: '   ' })).toBe(resolve('/x', 'data', 'packages'));
  });

  it('rejects relative override (it would silently land in cwd)', () => {
    // The override is meant for operators who want the storage on a
    // different disk / drive — accepting a relative path here would
    // be confusing because it'd be relative to the SERVER's cwd, not
    // the operator's shell cwd. Force absolute to prevent the trap.
    expect(() => resolveStorageBindPath({ cwd: '/x', override: 'relative/dir' })).toThrow(/absolute/i);
  });

  it('canonicalises the override (no trailing slash, OS-correct separators)', () => {
    const override = process.platform === 'win32'
      ? 'D:\\packages\\\\sub\\'
      : '/var/lib/packages/sub/';
    const r = resolveStorageBindPath({ cwd: '/x', override });
    // resolve() collapses doubled separators and strips trailing.
    expect(r).not.toMatch(/[\\/]$/);
    // Last segment is preserved.
    expect(r).toMatch(new RegExp(`sub$`));
  });

  it('defaults use the host OS separator', () => {
    const r = resolveStorageBindPath({ cwd: '/x', override: null });
    expect(r).toContain(`data${sep}packages`);
  });
});
