/**
 * Shared fixture for the child-agent host tests: the app and the children's
 * worker are two store instances over the same files, the queue and mailbox
 * live in the app's files, and the worker pool and command admission are
 * fakes (a "run" is a fake bus the test ends). The importing test mocks the
 * pool singleton, the control-plane shadow and the custom agents module.
 */
import { vi, type Mock } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { ChatCollaborationStore } from '@mcp/session-storage/collaboration/store.js';
import { fileChildAgentQueue } from '@mcp/code-agent/runtime/child-agent-queue-store.js';
import { buildConclusion } from '@mcp/code-agent/runtime/child-agent-conclusion.js';
import type { createChildAgentHost as CreateHost } from '../child-agent-host.js';

export async function childFixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const dataDir = join(root, 'data');
  for (const path of ['data/sessions/global', 'p1']) await mkdir(join(root, path), { recursive: true });
  const project = (id: number) => id === 1 ? { id, name: 'Project 1', root_path: join(root, 'p1') } : null;
  const open = () => FsSessionStore.fromRoots({ dataDir, projectRootResolver: {
    resolveProjectRoot: id => project(id)?.root_path, listProjectRoots: () => [{ project_id: 1, root_path: join(root, 'p1') }] } });
  const openMailbox = async () => { const mailbox = new ChatCollaborationStore(dataDir); await mailbox.init(); return mailbox; };
  const fixture = { root, project, app: open(), worker: open(), mailbox: await openMailbox() } as {
    root: string; project: typeof project; app: FsSessionStore; worker: FsSessionStore; mailbox: ChatCollaborationStore;
    queue: ReturnType<typeof fileChildAgentQueue>; rootId: string; holdLease(id: string): Promise<void>;
    conclude(id: string, text: string): Promise<void>; restart(): Promise<void>; close(): Promise<void>;
  };
  fixture.queue = fileChildAgentQueue(fixture.mailbox.files);
  fixture.rootId = (await fixture.app.createSession({ project_id: 1, title: 'Root', provider: 'p1', model: 'm1', agent: 'build' })).id;
  fixture.holdLease = async (id) => { await fixture.worker.refresh(); await fixture.worker.setSessionTitle(id, `${id} (running)`); };
  fixture.conclude = (id, text) => fixture.worker.recordChildAgentConclusion(id, buildConclusion({ runId: randomUUID(), state: 'completed',
    reason: 'completed', finalText: text, changedFiles: [], usage: { input_tokens: 1, output_tokens: 1 } }));
  fixture.restart = async () => {
    await Promise.all([fixture.app.close(), fixture.worker.close()]);
    fixture.app = open(); fixture.worker = open(); fixture.mailbox = await openMailbox();
    fixture.queue = fileChildAgentQueue(fixture.mailbox.files);
  };
  fixture.close = async () => {
    await Promise.all([fixture.app.close(), fixture.worker.close()]);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  return fixture;
}
export type ChildHostFixture = Awaited<ReturnType<typeof childFixture>>;

type HostInput = Parameters<typeof CreateHost>[0];
interface HostHarness {
  accepted: Map<string, string>;
  buses: Map<string, any>;
  runFresh: Mock;
  /** The pool's abort: ends the child's fake run as aborted. */
  abort: Mock;
  /** When set, a start waits for it before its run exists (a start in progress). */
  gate: Promise<void> | null;
  makeHost(extra?: Partial<HostInput>): ReturnType<typeof CreateHost>;
  /** Ends a child's fake run as completed; the host's end-of-run listeners run. */
  endRun(id: string): void;
  /** Feeds a bus event to a child's run as the worker would. */
  emit(id: string, event: string): void;
  reset(): void;
}

/** The fake pool and command admission, plus a host factory over them. */
export function hostHarness(createChildAgentHost: typeof CreateHost, f: () => ChildHostFixture): HostHarness {
  const harness: HostHarness = {
    accepted: new Map<string, string>(),
    buses: new Map<string, any>(),
    runFresh: vi.fn(),
    abort: vi.fn(),
    gate: null,
    makeHost(extra = {}) {
      harness.abort = vi.fn(async (id: string) => {
        const bus = harness.buses.get(id);
        if (!bus || bus.ended) return;
        bus.ended = true;
        bus.endReason = { event: 'done', data: { reason: 'aborted' } };
        for (const listener of bus.endListeners) listener();
      });
      harness.runFresh = vi.fn(async (id: string) => {
        if (harness.gate) await harness.gate;
        const bus = { busId: `bus-${id}`, ended: false, endReason: undefined as unknown, endListeners: new Set<() => void>(),
          eventSinks: new Set<(event: unknown) => void>(), ctrl: new AbortController() };
        harness.buses.set(id, bus);
        return bus;
      });
      return createChildAgentHost({
        deps: { sessionStore: f().app, controlPlaneStore: {}, providerStore: {}, config: { dbPath: join(f().root, 'none', 'index.db') } } as never,
        mailbox: f().mailbox,
        project: f().project,
        pool: { getBus: (id: string) => harness.buses.get(id), runFresh: harness.runFresh, abort: harness.abort } as never,
        accept: (async (input: { idempotencyKey: string }) => {
          if (harness.accepted.has(input.idempotencyKey)) return { outcome: 'existing', commandStatus: harness.accepted.get(input.idempotencyKey) };
          harness.accepted.set(input.idempotencyKey, 'running');
          return { outcome: 'accepted', runContext: undefined };
        }) as never,
        bind: (async () => true) as never,
        terminalize: (async () => undefined) as never,
        resolveAgent: () => ({ baseAgentId: 'explore', selectionId: 'explore' }),
        ...extra,
      });
    },
    endRun(id) {
      const bus = harness.buses.get(id)!;
      bus.ended = true;
      bus.endReason = { event: 'done', data: { reason: 'completed' } };
      for (const listener of bus.endListeners) listener();
    },
    emit(id, event) {
      for (const sink of harness.buses.get(id)!.eventSinks) sink({ seq: Date.now(), event, data: {} });
    },
    reset() { harness.accepted = new Map(); harness.buses = new Map(); harness.gate = null; },
  };
  return harness;
}
