/**
 * Shared fixture for child-agent queue, admission and wait tests: the app and
 * the children's worker are two session store instances over the same files,
 * as in production. The queue lives in the app's collaboration files. The
 * worker can hold a child's writer lease (holdLease), so any app write into a
 * child bundle fails with SessionLeaseHeldError.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { ChatCollaborationStore } from '@mcp/session-storage/collaboration/store.js';
import { createChildAgentSession } from '../child-agent-sessions.js';
import { fileChildAgentQueue, type ChildAgentQueueStore } from '../child-agent-queue-store.js';
import { buildConclusion } from '../child-agent-conclusion.js';
import type { ChildAgentAdmissionStore } from '../child-agent-admission.js';

export interface ChildFixture {
  root: string;
  dataDir: string;
  app: FsSessionStore;
  worker: FsSessionStore;
  mailbox: ChatCollaborationStore;
  queue: ChildAgentQueueStore;
  rootId: string;
  project(id: number): { id: number; name: string; root_path: string } | null;
  /** The app's read-only view of child bundles. */
  reads(): ChildAgentAdmissionStore;
  child(parentId: string, key: string, profile?: string): Promise<string>;
  /** The worker takes (and keeps) the writer lease of a child bundle. */
  holdLease(childId: string): Promise<void>;
  runRecord(childId: string, status: 'running' | 'completed'): Promise<void>;
  conclude(childId: string, finalText: string, at?: Date): Promise<void>;
  /** Both sides restart: new store instances and a new queue store over the same files. */
  restart(): Promise<void>;
  close(): Promise<void>;
}

export async function childFixture(prefix: string): Promise<ChildFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const dataDir = join(root, 'data');
  for (const path of ['data/sessions/global', 'p1']) await mkdir(join(root, path), { recursive: true });
  const project = (id: number) => id === 1 ? { id, name: 'Project 1', root_path: join(root, 'p1') } : null;
  const open = () => FsSessionStore.fromRoots({ dataDir, projectRootResolver: {
    resolveProjectRoot: id => project(id)?.root_path, listProjectRoots: () => [{ project_id: 1, root_path: join(root, 'p1') }] } });
  const openMailbox = async () => { const mailbox = new ChatCollaborationStore(dataDir); await mailbox.init(); return mailbox; };

  const fixture = { root, dataDir, project, app: open(), worker: open(), mailbox: await openMailbox() } as ChildFixture;
  fixture.queue = fileChildAgentQueue(fixture.mailbox.files);
  fixture.rootId = (await fixture.app.createSession({ project_id: 1, title: 'Root', provider: 'p1', model: 'm1', agent: 'build' })).id;
  fixture.reads = () => ({
    getChildAgentSession: (id) => fixture.app.getChildAgentSession(id),
    listChildAgentSessions: (id) => fixture.app.listChildAgentSessions(id),
    listSubagentRuns: (id, offset, limit) => fixture.app.listSubagentRuns(id, offset, limit),
    refreshSession: (id) => fixture.app.refreshSession(id),
  });
  fixture.child = async (parentId, key, profile = 'explore') => {
    await new Promise((done) => setTimeout(done, 5)); // distinct creation timestamps
    return (await createChildAgentSession({ sessions: fixture.app, project }, parentId, { key, title: key, profile })).child.id;
  };
  fixture.holdLease = async (childId) => {
    // A worker opens its store for its own session; this shared one rescans for new children.
    await fixture.worker.refresh();
    await fixture.worker.setSessionTitle(childId, `${childId} (running)`);
  };
  fixture.runRecord = async (childId, status) => {
    const fence = await fixture.worker.startSubagentRun({ session_id: childId as never, run_id: randomUUID(), profile: 'explore', max_turns: 0 });
    if (status === 'completed') await fixture.worker.completeSubagentRun({ run_id: fence.run_id, reason: 'completed', turns: 1, auto_continues: 0,
      tool_calls: 0, logical_operations: 0, productive_operations: 0, paginate_calls: 0, duplicate_calls: 0, error_calls: 0,
      refused_calls: 0, elapsed_ms: 1, input_tokens: 0, output_tokens: 0, has_summary: true, fence });
  };
  fixture.conclude = (childId, finalText, at = new Date()) => fixture.worker.recordChildAgentConclusion(childId, buildConclusion({
    runId: randomUUID(), state: 'completed', reason: 'completed', finalText, changedFiles: ['src/a.ts'],
    usage: { input_tokens: 10, output_tokens: 4 }, now: at }));
  fixture.restart = async () => {
    await Promise.all([fixture.app.close(), fixture.worker.close()]);
    fixture.app = open();
    fixture.worker = open();
    fixture.mailbox = await openMailbox();
    fixture.queue = fileChildAgentQueue(fixture.mailbox.files);
  };
  fixture.close = async () => {
    await Promise.all([fixture.app.close(), fixture.worker.close()]);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  return fixture;
}
