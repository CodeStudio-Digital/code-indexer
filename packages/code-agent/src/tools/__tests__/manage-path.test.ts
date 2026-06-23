import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { extractPathsFromToolArgs } from '@mcp/code-agent/core/runner.js';
import { managePathTool } from '@mcp/code-agent/tools/manage-path.js';

let dir: string;

function ctx(): ToolContext {
  return { cwd: dir, projectName: 'manage-path-test' };
}

beforeEach(() => {
  dir = join(tmpdir(), `manage-path-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('manage_path mkdir', () => {
  it('creates nested directories idempotently', async () => {
    const args = { operation: 'mkdir', path: 'src/features/demo' };
    const first = await managePathTool.handler(args, ctx());
    const second = await managePathTool.handler(args, ctx());

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    expect(existsSync(join(dir, 'src/features/demo'))).toBe(true);
    expect(second.content).toContain('already exists');
  });

  it('blocks protected roots and traversal', async () => {
    const git = await managePathTool.handler({ operation: 'mkdir', path: '.git/hooks' }, ctx());
    const outside = await managePathTool.handler({ operation: 'mkdir', path: '../escape' }, ctx());

    expect(git.isError).toBe(true);
    expect(git.content).toContain('protected');
    expect(outside.isError).toBe(true);
    expect(outside.content).toContain('traversal');
  });
});

describe('manage_path move', () => {
  it('moves files and creates destination parents', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello', 'utf-8');

    const result = await managePathTool.handler({
      operation: 'move',
      from_path: 'a.txt',
      to_path: 'nested/b.txt',
    }, ctx());

    expect(result.isError).toBeFalsy();
    expect(existsSync(join(dir, 'a.txt'))).toBe(false);
    expect(readFileSync(join(dir, 'nested/b.txt'), 'utf-8')).toBe('hello');
  });

  it('fails when the destination already exists', async () => {
    writeFileSync(join(dir, 'a.txt'), 'a', 'utf-8');
    writeFileSync(join(dir, 'b.txt'), 'b', 'utf-8');

    const result = await managePathTool.handler({
      operation: 'move',
      from_path: 'a.txt',
      to_path: 'b.txt',
    }, ctx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('already exists');
    expect(readFileSync(join(dir, 'a.txt'), 'utf-8')).toBe('a');
    expect(readFileSync(join(dir, 'b.txt'), 'utf-8')).toBe('b');
  });
});

describe('manage_path delete', () => {
  it('moves files to trash by default', async () => {
    writeFileSync(join(dir, 'old.txt'), 'bye', 'utf-8');

    const result = await managePathTool.handler({
      operation: 'delete',
      path: 'old.txt',
    }, ctx());

    expect(result.isError).toBeFalsy();
    expect(existsSync(join(dir, 'old.txt'))).toBe(false);
    const trashRoot = join(dir, '.mcp-indexer/trash');
    expect(readdirSync(trashRoot).length).toBe(1);
    expect(result.content).toContain('Moved old.txt to trash');
  });

  it('requires recursive confirmation for non-empty directories', async () => {
    mkdirSync(join(dir, 'folder'), { recursive: true });
    writeFileSync(join(dir, 'folder/file.txt'), 'x', 'utf-8');

    const missingConfirm = await managePathTool.handler({
      operation: 'delete',
      path: 'folder',
      recursive: true,
    }, ctx());
    const confirmed = await managePathTool.handler({
      operation: 'delete',
      path: 'folder',
      recursive: true,
      confirm: 'DELETE folder',
    }, ctx());

    expect(missingConfirm.isError).toBe(true);
    expect(missingConfirm.content).toContain("confirm='DELETE folder'");
    expect(confirmed.isError).toBeFalsy();
    expect(existsSync(join(dir, 'folder'))).toBe(false);
  });

  it('requires literal confirmation for permanent delete', async () => {
    writeFileSync(join(dir, 'gone.txt'), 'x', 'utf-8');

    const denied = await managePathTool.handler({
      operation: 'delete',
      path: 'gone.txt',
      delete_mode: 'permanent',
    }, ctx());
    const confirmed = await managePathTool.handler({
      operation: 'delete',
      path: 'gone.txt',
      delete_mode: 'permanent',
      confirm: 'PERMANENT DELETE gone.txt',
    }, ctx());

    expect(denied.isError).toBe(true);
    expect(denied.content).toContain('PERMANENT DELETE gone.txt');
    expect(confirmed.isError).toBeFalsy();
    expect(existsSync(join(dir, 'gone.txt'))).toBe(false);
  });
});

describe('manage_path scope extraction', () => {
  it('extracts source and destination paths for task-scope checks', () => {
    expect(extractPathsFromToolArgs('manage_path', {
      operation: 'move',
      from_path: 'src/a.ts',
      to_path: 'src/b.ts',
    })).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts']));
  });
});
