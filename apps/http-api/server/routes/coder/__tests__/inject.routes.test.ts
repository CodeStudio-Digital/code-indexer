/**
 * Unit test for POST /api/coder/sessions/:id/inject (mandatory worker path).
 *
 * Mounts the coder interaction routes with STUB sessionStore + runtime (no DB,
 * no real worker) so it's ABI-free. The worker pool RPC surface is mocked.
 * Validates the three outcomes the dashboard queue depends on:
 * injected (live run), noActiveRun (no run → client falls back to /messages),
 * and the empty-content 400.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpRouter } from '@mcp/shared/http/router.js';
import { asSessionId, type SessionId } from '@mcp/agent-runtime-contracts';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SESSION_ID = asSessionId('22222222-2222-4222-8222-222222222222');

const { poolMock } = vi.hoisted(() => ({
  poolMock: {
    getBus: vi.fn(),
    isWaitingForInput: vi.fn(),
    interruptWait: vi.fn(),
    pushUserMessage: vi.fn(),
  },
}));

vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({
  getCoderWorkerPool: () => poolMock,
}));

import { mountCoderInteractionRoutes } from '../interaction.js';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';

function liveBus() {
  // Shape `emitWorkerLog`/`publish` touch (nextSeq/buffer/subscribers) plus the
  // fields /inject and worker logging read.
  return { ended: false, nextSeq: 0, buffer: [] as unknown[], subscribers: new Set(), eventSinks: [] as unknown[] };
}

function setup(opts: { live?: boolean; waiting?: boolean } = {}) {
  const appendCalls: Array<{
    session_id: SessionId;
    operation_id: string;
    message: unknown;
  }> = [];
  const filesystemRoots: Array<{
    id: string;
    seq: number;
    root_path: string;
    access: 'read' | 'write';
  }> = [];
  const bus = opts.live === false ? null : liveBus();
  poolMock.getBus.mockImplementation((id: SessionId) => id === SESSION_ID ? bus : null);
  poolMock.isWaitingForInput.mockResolvedValue(!!opts.waiting);
  poolMock.interruptWait.mockResolvedValue(undefined);
  poolMock.pushUserMessage.mockResolvedValue(42);

  const deps = {
    sessionStore: {
      getSession: async () => ({
        id: SESSION_ID,
        provider: null,
        model: null,
        project_id: null,
        is_global: false,
        worktree_path: null,
      }),
      listSessionFilesystemRoots: async () => [...filesystemRoots],
      upsertSessionFilesystemRoot: async (
        _sessionId: SessionId,
        rootPath: string,
        access: 'read' | 'write',
      ) => {
        const row = {
          id: `root-${filesystemRoots.length + 1}`,
          seq: filesystemRoots.length + 1,
          root_path: rootPath,
          access,
        };
        filesystemRoots.push(row);
        return row;
      },
      appendMessage: async (input: {
        session_id: SessionId;
        operation_id: string;
        message: unknown;
      }) => {
        appendCalls.push(input);
        return 42;
      },
    },
    providerStore: {
      getProvider: () => undefined,
      listModels: () => [],
    },
    db: {
      getProject: () => null,
    },
  } as unknown as ServerDeps;
  const runtime = {
    activeRuns: new Map(),
    findPendingInteraction: async () => null,
    findDanglingToolUse: async () => null,
  } as unknown as CoderRuntime;

  const app = new HttpRouter();
  mountCoderInteractionRoutes(app, deps, runtime);

  const inject = (id: SessionId, body: unknown) =>
    app.request(`/api/coder/sessions/${id}/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  return { inject, appendCalls, filesystemRoots };
}

beforeEach(() => vi.clearAllMocks());

describe('coder POST /sessions/:id/inject', () => {
  it('enqueues into a live run and returns injected', async () => {
    const h = setup({ live: true });
    const r = await h.inject(SESSION_ID, { content: 'follow-up', selected_skill_ids: ['s1'] });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ injected: true });
    expect(h.appendCalls).toHaveLength(0);
    expect(poolMock.pushUserMessage).toHaveBeenCalledWith(
      SESSION_ID,
      'follow-up',
      ['s1'],
      expect.stringMatching(/^interaction:inject:/),
    );
  });

  it('preserves validated attachments in the live-run enqueue', async () => {
    const h = setup({ live: true });
    const attachment = {
      name: 'notes.txt',
      mediaType: 'text/plain',
      text: 'attachment details',
    };
    const r = await h.inject(SESSION_ID, {
      content: 'follow-up with context',
      attachments: [attachment],
    });

    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ injected: true });
    expect(poolMock.pushUserMessage).toHaveBeenCalledWith(
      SESSION_ID,
      'follow-up with context',
      undefined,
      expect.stringMatching(/^interaction:inject:/),
      [attachment],
    );
  });

  it('supplies the attachment-only default prompt instead of rejecting the queue item', async () => {
    const h = setup({ live: true });
    const attachment = {
      name: 'notes.txt',
      mediaType: 'text/plain',
      text: 'attachment details',
    };
    const r = await h.inject(SESSION_ID, { content: '', attachments: [attachment] });

    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ injected: true });
    expect(poolMock.pushUserMessage).toHaveBeenCalledWith(
      SESSION_ID,
      expect.stringMatching(/attached files/i),
      undefined,
      expect.stringMatching(/^interaction:inject:/),
      [attachment],
    );
  });

  it('authorizes an exact local file reference before enqueueing it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-queued-attachment-'));
    try {
      const rawPath = join(dir, 'context.tmp');
      writeFileSync(rawPath, 'local context');
      const canonicalPath = realpathSync(rawPath);
      const h = setup({ live: true });
      const r = await h.inject(SESSION_ID, {
        content: 'inspect the local file',
        attachments: [{
          name: 'context.tmp',
          mediaType: 'application/octet-stream',
          path: rawPath,
        }],
      });

      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ injected: true });
      expect(h.filesystemRoots).toEqual([expect.objectContaining({
        root_path: canonicalPath,
        access: 'read',
      })]);
      expect(poolMock.pushUserMessage).toHaveBeenCalledWith(
        SESSION_ID,
        'inspect the local file',
        undefined,
        expect.stringMatching(/^interaction:inject:/),
        [expect.objectContaining({ path: canonicalPath })],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns noActiveRun when there is no live run', async () => {
    const h = setup({ live: false });
    const r = await h.inject(SESSION_ID, { content: 'hello' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ noActiveRun: true });
    expect(h.appendCalls).toHaveLength(0);
    expect(poolMock.pushUserMessage).not.toHaveBeenCalled();
  });

  it('400s on empty content', async () => {
    const h = setup({ live: true });
    const r = await h.inject(SESSION_ID, { content: '   ' });
    expect(r.status).toBe(400);
    expect(poolMock.pushUserMessage).not.toHaveBeenCalled();
  });

  it('returns waiting when blocked and interject is not set', async () => {
    const h = setup({ live: true, waiting: true });
    const r = await h.inject(SESSION_ID, { content: 'hi' });
    expect(await r.json()).toEqual({ waiting: true });
    expect(poolMock.pushUserMessage).not.toHaveBeenCalled();
  });

  it('interrupts the wait and injects when interject is set', async () => {
    const h = setup({ live: true, waiting: true });
    const r = await h.inject(SESSION_ID, { content: 'hi', interject: true });
    expect(await r.json()).toEqual({ injected: true });
    expect(poolMock.interruptWait).toHaveBeenCalledWith(SESSION_ID);
    expect(poolMock.pushUserMessage).toHaveBeenCalledTimes(1);
  });
});
