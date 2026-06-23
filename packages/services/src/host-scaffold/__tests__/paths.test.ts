import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { userProjectsRoot, resolveTargetPath } from '../paths.js';

const created: string[] = [];
function freshRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'host-scaffold-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length) {
    try { rmSync(created.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('userProjectsRoot', () => {
  it('honors MCP_USER_PROJECTS_DIR override', () => {
    expect(userProjectsRoot({ MCP_USER_PROJECTS_DIR: '/custom/dir' } as NodeJS.ProcessEnv))
      .toBe(path.resolve('/custom/dir'));
  });

  it('defaults to <dataDir>/projects', () => {
    const root = userProjectsRoot({} as NodeJS.ProcessEnv);
    expect(root.replace(/\\/g, '/')).toMatch(/\.mcp-code-indexer\/projects$/);
  });

  it('follows MCP_DATA_DIR for the base when no explicit override', () => {
    const root = userProjectsRoot({ MCP_DATA_DIR: '/data/mcp' } as NodeJS.ProcessEnv);
    expect(root.replace(/\\/g, '/')).toMatch(/\/data\/mcp\/projects$/);
  });
});

describe('resolveTargetPath', () => {
  it('produces slug + absolute path under root', () => {
    const root = freshRoot();
    const r = resolveTargetPath('My App', { root });
    expect(r.slug).toBe('my-app');
    expect(r.name).toBe('My App');
    expect(r.targetPath).toBe(path.join(root, 'my-app'));
  });

  it('suffixes both slug and name when the directory already exists', () => {
    const root = freshRoot();
    mkdirSync(path.join(root, 'my-app'));
    const r = resolveTargetPath('My App', { root });
    expect(r.slug).toBe('my-app-2');
    expect(r.name).toBe('My App 2');
  });

  it('suffixes when the display name is already taken in the DB', () => {
    const root = freshRoot();
    const r = resolveTargetPath('My App', { root, isNameTaken: (n) => n === 'My App' });
    expect(r.slug).toBe('my-app-2');
    expect(r.name).toBe('My App 2');
  });
});
