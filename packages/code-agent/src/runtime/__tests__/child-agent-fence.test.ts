/**
 * The fence of a child-agent session run lives in the child's own bundle and
 * authorizes the inherited working directory only. A violation, or losing
 * the run record, reaches the child's abort callback and nothing else.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { createChildAgentSession } from '../child-agent-sessions.js';
import { loadChildAgentRun } from '../child-agent-run.js';
import { startChildAgentFence, type ChildAgentFenceStore } from '../child-agent-fence.js';

let root: string, sessions: FsSessionStore, parentId: string, childId: string;
const project = (id: number) => id === 1 ? { id, name: 'Project 1', root_path: join(root, 'p1') } : null;
const usage = { input_tokens: 3, output_tokens: 2 };
const RUN_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'child-agent-fence-'));
  for (const path of ['data/sessions/global', 'p1']) await mkdir(join(root, path), { recursive: true });
  sessions = FsSessionStore.fromRoots({ dataDir: join(root, 'data'), projectRootResolver: {
    resolveProjectRoot: id => project(id)?.root_path,
    listProjectRoots: () => [{ project_id: 1, root_path: join(root, 'p1') }],
  } });
  parentId = (await sessions.createSession({ project_id: 1, title: 'Parent', provider: 'p1', model: 'm1' })).id;
  childId = (await createChildAgentSession({ sessions, project }, parentId, { key: 'k', title: 'Child', profile: 'implement' })).child.id;
});
afterEach(async () => { await sessions.close(); await rm(root, { recursive: true, force: true }); });

async function start(store: ChildAgentFenceStore, violations: string[], heartbeatMs?: number) {
  const run = (await loadChildAgentRun(sessions, childId))!;
  return startChildAgentFence(store, { sessionId: childId as never, runId: RUN_ID, run, cwd: join(root, 'p1'),
    provider: 'p1', model: 'm1', capabilities: ['read_file', 'write_file'], onViolation: (message) => violations.push(message), heartbeatMs });
}

const write = (fence: Awaited<ReturnType<typeof start>>, path: string) => fence.mutationFence.bindInvocation!({
  toolName: 'write_file', toolUseId: `w:${path}`, effectiveInput: { path, content: 'x' }, boundary: 'filesystem', requiresEffectBoundary: true,
}).assertMutation({ kind: 'filesystem', operation: 'writeFile', resource: path });

describe('child-agent session fence', () => {
  it('records the run in the child bundle and completes it there', async () => {
    const fence = await start(sessions, []);
    await fence.complete({ reason: 'completed', turns: 2, toolCalls: 4, usage, hasSummary: false });
    fence.stop();
    const childRuns = await sessions.listSubagentRuns(childId, 0, 10);
    expect(childRuns.items).toHaveLength(1);
    expect(childRuns.items[0]).toMatchObject({ run_id: RUN_ID, profile: 'implement', status: 'completed', tool_calls: 4 });
    expect((await sessions.listSubagentRuns(parentId, 0, 10)).items).toEqual([]);
  });

  it('authorizes the working directory and reports a write outside it', async () => {
    const violations: string[] = [];
    const fence = await start(sessions, violations);
    expect(() => write(fence, resolve(root, 'p1', 'src', 'a.ts'))).not.toThrow();
    expect(() => write(fence, resolve(root, 'elsewhere', 'b.ts'))).toThrow();
    expect(violations).toHaveLength(1);
    fence.stop();
  });

  it('aborts the child when its run record stops being current', async () => {
    const violations: string[] = [];
    const revoking: ChildAgentFenceStore = {
      startSubagentRun: (input) => sessions.startSubagentRun(input),
      completeSubagentRun: (input) => sessions.completeSubagentRun(input),
      assertSubagentRunFence: async () => { throw new Error('fence superseded'); },
    };
    const fence = await start(revoking, violations, 50);
    await new Promise((done) => setTimeout(done, 1_300));
    fence.stop();
    expect(violations.join('\n')).toMatch(/no longer current/);
  });
});
