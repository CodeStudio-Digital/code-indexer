/**
 * Files a child agent changed read fresh in the parent, as after the
 * parent's own edit (overlay marked, index refreshed), on the wait path (a
 * claim) and on the background path (a sweep). The overwrite guard still
 * refuses the parent a blind overwrite of a file it had read before the child
 * changed it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../../core/tool.js';
import { SessionOverlay } from '../../overlay/session-overlay.js';
import { SessionFileKnowledge } from '../../tools/file-knowledge.js';
import { fsTools } from '../../tools/fs.js';
import { createChildAgentAccounting, markChildAgentChanges } from '../child-agent-freshness.js';
import type { ChildAgentRunUsage } from '../child-agent-usage.js';

let root: string;
let ctx: ToolContext;
let reindexed: Array<[number, string, string]>;
const reindex = async (projectId: number, relPath: string, absPath: string) => { reindexed.push([projectId, relPath, absPath]); };
const tool = (name: string) => fsTools.find((candidate) => candidate.name === name)!;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'child-agent-freshness-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  ctx = { cwd: root, projectName: 'p', projectId: 1, overlay: new SessionOverlay(root), fileKnowledge: new SessionFileKnowledge() } as ToolContext;
  reindexed = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const childRun = (changedFiles: string[]): ChildAgentRunUsage =>
  ({ key: 'child-run:r1', childId: 'c1', runId: 'r1', usage: { input_tokens: 9, output_tokens: 1 }, changedFiles });

describe('fresh reads in the parent after a child agent changed files', () => {
  it('marks the overlay and refreshes the index of files in the parent project only', async () => {
    const marked = markChildAgentChanges(ctx, ['src/a.ts', join(root, 'src', 'b.ts'), '../outside.ts'], reindex);
    await Promise.resolve();
    expect(marked).toEqual(['src/a.ts', 'src/b.ts']);
    expect(ctx.overlay!.isDirty('src/a.ts')).toBe(true);
    expect(ctx.overlay!.isDirty('src/b.ts')).toBe(true);
    expect(reindexed).toEqual([[1, 'src/a.ts', join(root, 'src', 'a.ts')], [1, 'src/b.ts', join(root, 'src', 'b.ts')]]);
  });

  it('keeps refusing a blind overwrite of a file the parent read before the child changed it', async () => {
    expect((await tool('read_file').handler({ path: 'src/a.ts' }, ctx)).isError).toBeFalsy();
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2; // the child\n'); // the child's worker edits it
    markChildAgentChanges(ctx, ['src/a.ts'], reindex);
    const blind = await tool('write_file').handler({ path: 'src/a.ts', content: 'export const a = 3;\n' }, ctx);
    expect(blind.isError).toBe(true);
    expect(blind.content).toMatch(/changed on disk since this session last read or wrote it/);
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2; // the child\n');
    // After reading the child's version, the parent may write.
    expect((await tool('read_file').handler({ path: 'src/a.ts' }, ctx)).isError).toBeFalsy();
    expect((await tool('write_file').handler({ path: 'src/a.ts', content: 'export const a = 3;\n' }, ctx)).isError).toBeFalsy();
  });

  it('does the same on the wait path and on the background path', async () => {
    const claimed = childRun(['src/a.ts']);
    const swept = childRun(['src/c.ts']);
    const accounting = createChildAgentAccounting({ toolContext: ctx, reindex, ledger: {
      claimForTurn: async () => ({ usage: claimed.usage, keys: [claimed.key], runs: [claimed] }),
      sweep: async () => [swept],
    } });
    expect(await accounting.claim(['c1'])).toEqual({ subUsage: claimed.usage, subUsageRuns: [claimed.key] });
    expect(ctx.overlay!.isDirty('src/a.ts')).toBe(true);
    expect(await accounting.sweep()).toEqual([swept]);
    expect(ctx.overlay!.isDirty('src/c.ts')).toBe(true);
    await Promise.resolve();
    expect(reindexed.map(([, relPath]) => relPath)).toEqual(['src/a.ts', 'src/c.ts']);
  });

  it('returns no usage for a claim that found nothing new', async () => {
    const accounting = createChildAgentAccounting({ toolContext: ctx, ledger: {
      claimForTurn: async () => ({ usage: null, keys: [], runs: [] }), sweep: async () => [] } });
    expect(await accounting.claim(['c1'])).toEqual({});
  });
});
