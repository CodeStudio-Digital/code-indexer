import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSystemPromptHook, runToolFilterHook } from '../hooks.js';

const roots: string[] = [];
const ctx = { projectName: 'p', projectRoot: '', os: 'win32' };
const filterCtx = { projectName: 'p', providerName: 'x', model: 'm' };

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'file-hooks-'));
  mkdirSync(join(root, '.mcp-indexer', 'hooks'), { recursive: true });
  roots.push(root);
  return root;
}

/** Write a hook and move its mtime so the edit is visible even on coarse clocks. */
function writeHook(root: string, name: string, body: string, mtimeSec: number): void {
  const path = join(root, '.mcp-indexer', 'hooks', `${name}.js`);
  writeFileSync(path, body);
  utimesSync(path, mtimeSec, mtimeSec);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project file hooks', () => {
  it('uses an edited system-prompt hook on the next prompt build', () => {
    const root = project();
    writeHook(root, 'system-prompt', "module.exports = () => 'first';", 1_700_000_000);
    expect(runSystemPromptHook(root, { ...ctx, projectRoot: root })).toBe('first');
    writeHook(root, 'system-prompt', "module.exports = () => 'second';", 1_700_000_100);
    expect(runSystemPromptHook(root, { ...ctx, projectRoot: root })).toBe('second');
  });

  it('uses an edited tool-filter hook on the next catalog build', () => {
    const root = project();
    const tools = [{ name: 'read_file', source: 'native' }, { name: 'grep', source: 'native' }];
    writeHook(root, 'tool-filter', "module.exports = (c) => c.tools.filter(t => t.name === 'read_file');", 1_700_000_000);
    expect([...(runToolFilterHook(root, tools, filterCtx) ?? [])]).toEqual(['read_file']);
    writeHook(root, 'tool-filter', "module.exports = (c) => c.tools.filter(t => t.name === 'grep');", 1_700_000_100);
    expect([...(runToolFilterHook(root, tools, filterCtx) ?? [])]).toEqual(['grep']);
  });

  it('stops running a hook once its file is deleted', () => {
    const root = project();
    writeHook(root, 'system-prompt', "module.exports = () => 'present';", 1_700_000_000);
    expect(runSystemPromptHook(root, { ...ctx, projectRoot: root })).toBe('present');
    unlinkSync(join(root, '.mcp-indexer', 'hooks', 'system-prompt.js'));
    expect(runSystemPromptHook(root, { ...ctx, projectRoot: root })).toBe('');
  });

  it('keeps both hooks of one project independent', () => {
    const root = project();
    writeHook(root, 'system-prompt', "module.exports = () => 'prompt';", 1_700_000_000);
    writeHook(root, 'tool-filter', "module.exports = () => ['only'];", 1_700_000_000);
    expect(runSystemPromptHook(root, { ...ctx, projectRoot: root })).toBe('prompt');
    expect([...(runToolFilterHook(root, [], filterCtx) ?? [])]).toEqual(['only']);
    expect(runSystemPromptHook(root, { ...ctx, projectRoot: root })).toBe('prompt');
  });
});
