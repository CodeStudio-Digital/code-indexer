import { describe, it, expect, afterEach } from 'vitest';
import { join, resolve } from 'node:path';
import { resolveStorageBindPath } from '@mcp/services/verdaccio/storage-paths.js';
import { mcpDataDir } from '@mcp/shared/utils/config.js';

describe('resolveStorageBindPath', () => {
  const orig = process.env.MCP_DATA_DIR;
  afterEach(() => {
    if (orig === undefined) delete process.env.MCP_DATA_DIR;
    else process.env.MCP_DATA_DIR = orig;
  });

  it('defaults to <mcpDataDir>/packages (no longer the project-root data/)', () => {
    delete process.env.MCP_DATA_DIR;
    const r = resolveStorageBindPath({ override: null });
    expect(r).toBe(join(mcpDataDir(), 'packages'));
  });

  it('follows MCP_DATA_DIR', () => {
    process.env.MCP_DATA_DIR = process.platform === 'win32' ? 'D:\\custom-data' : '/custom-data';
    expect(resolveStorageBindPath({ override: null })).toBe(
      resolve(process.env.MCP_DATA_DIR, 'packages'),
    );
  });

  it('uses MCP_VERDACCIO_STORAGE_DIR override when supplied', () => {
    const override = '/mnt/registry-backups/packages';
    expect(resolveStorageBindPath({ override })).toBe(resolve(override));
  });

  it('treats empty / whitespace override as unset', () => {
    delete process.env.MCP_DATA_DIR;
    expect(resolveStorageBindPath({ override: '' })).toBe(join(mcpDataDir(), 'packages'));
    expect(resolveStorageBindPath({ override: '   ' })).toBe(join(mcpDataDir(), 'packages'));
  });

  it('rejects relative override (it would silently land in cwd)', () => {
    // The override is meant for operators who want the storage on a
    // different disk / drive — accepting a relative path here would
    // be confusing because it'd be relative to the SERVER's cwd, not
    // the operator's shell cwd. Force absolute to prevent the trap.
    expect(() => resolveStorageBindPath({ override: 'relative/dir' })).toThrow(/absolute/i);
  });

  it('canonicalises the override (no trailing slash, OS-correct separators)', () => {
    const override = process.platform === 'win32'
      ? 'D:\\packages\\\\sub\\'
      : '/var/lib/packages/sub/';
    const r = resolveStorageBindPath({ override });
    // resolve() collapses doubled separators and strips trailing.
    expect(r).not.toMatch(/[\\/]$/);
    // Last segment is preserved.
    expect(r).toMatch(/sub$/);
  });
});
