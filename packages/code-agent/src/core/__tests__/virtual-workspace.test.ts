import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGlobalWorkspace, cleanupGlobalWorkspace } from '../virtual-workspace.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('virtual global workspace', () => {
  it('reconciles stale junctions against the requested project set', () => {
    const base = mkdtempSync(join(tmpdir(), 'global-workspace-'));
    roots.push(base);
    const union = join(base, 'union');
    const oldTarget = join(base, 'old');
    const newTarget = join(base, 'new');
    mkdirSync(oldTarget);
    mkdirSync(newTarget);

    buildGlobalWorkspace(union, [{ name: 'Old Project', rootPath: oldTarget }]);
    expect(existsSync(join(union, 'old_project'))).toBe(true);
    mkdirSync(join(union, '.mcp-indexer', 'coder'), { recursive: true });
    writeFileSync(join(union, '.mcp-indexer', 'coder', 'legacy.txt'), 'legacy');

    buildGlobalWorkspace(union, [{ name: 'New Project', rootPath: newTarget }]);
    expect(existsSync(join(union, 'old_project'))).toBe(false);
    expect(existsSync(join(union, 'new_project'))).toBe(true);
    expect(existsSync(join(union, '.mcp-indexer'))).toBe(false);
  });

  it('removes only links and the known legacy artifact tree during cleanup', () => {
    const base = mkdtempSync(join(tmpdir(), 'global-workspace-cleanup-'));
    roots.push(base);
    const union = join(base, 'union');
    const target = join(base, 'project');
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'keep');
    buildGlobalWorkspace(union, [{ name: 'Project', rootPath: target }]);
    const artifacts = join(union, '.mcp-indexer', 'coder', 'tool-outputs', '1');
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, 'output.txt'), 'temporary');
    symlinkSync(target, join(artifacts, 'nested-project-link'), 'junction');

    cleanupGlobalWorkspace(union);

    expect(existsSync(union)).toBe(false);
    expect(existsSync(join(target, 'keep.txt'))).toBe(true);
  });

  it('does not create a junction when the registered target is absent', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const base = mkdtempSync(join(tmpdir(), 'global-workspace-missing-'));
    roots.push(base);
    const union = join(base, 'union');
    const links = buildGlobalWorkspace(union, [{
      name: 'Missing Project',
      rootPath: join(base, 'does-not-exist'),
    }]);

    expect(links).toEqual([]);
    expect(() => lstatSync(join(union, 'missing_project'))).toThrow();
  });
});
