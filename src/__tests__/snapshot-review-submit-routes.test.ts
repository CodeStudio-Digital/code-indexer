/**
 * `/snapshot/reviews/submit` delivery wiring.
 *
 * Company-scope reviews must route the compiled feedback to the master via
 * the injected `deliverMessage` hook (which production binds to
 * `orchestrator.sendMessageToMaster`). Coder-scope mounts omit the hook and
 * forward via the chat stream instead — so the two paths never double-deliver.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { SessionFileSnapshotStore } from '@mcp/store/session-file-snapshot-store.js';
import { SessionFileReviewStore } from '@mcp/store/session-file-review-store.js';
import { mountSnapshotReviewRoutes } from '@apps/http-api/server/routes/snapshot-review-routes.js';
import type { ServerDeps } from '@apps/http-api/server/deps.js';

function setup() {
  const workDir = mkdtempSync(join(tmpdir(), 'snap-review-submit-'));
  const dbPath = join(workDir, 'index.sqlite');
  const db = new CodeIndexDB(dbPath);
  const sessionStore = new SessionStore(dbPath);
  const project = db.createProject('test-proj', workDir);
  const session = sessionStore.createSession({
    project_id: project.id,
    title: 'review submit',
    provider: 'zai',
    model: 'glm-5',
  });
  const snapshotStore = new SessionFileSnapshotStore(sessionStore.getDb());
  const reviewStore = new SessionFileReviewStore(sessionStore.getDb());

  // A real baseline so its id appears in `allBaselineIds` and the comment
  // passes the route's `allowed` check.
  const { baseline } = snapshotStore.recordBaselineAndEdit(
    {
      session_kind: 'coder',
      session_id: session.id,
      file_path: 'src/foo.ts',
      content_before: 'before\n',
      existed_before: true,
      baseline_hash: 'hash-foo',
      oversized: false,
    },
    { turn_number: 1, tool_name: 'write_file', content_after_hash: 'hash-after', was_delete: false },
  );

  const comment = reviewStore.createComment({
    baseline_id: baseline.id,
    source: 'manual',
    status: 'open',
    file_path: 'src/foo.ts',
    body: 'Use a constant instead of the magic number.',
  });

  // Only the slice the snapshot-review routes actually touch.
  const deps = { sessionStore, db } as unknown as ServerDeps;

  return {
    workDir, db, sessionStore, reviewStore, session, comment, deps,
    cleanup: () => {
      sessionStore.close();
      db.close();
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

async function postSubmit(app: Hono, scope: 'coder' | 'company', sessionId: number, commentIds: number[]) {
  const res = await app.request(`/api/${scope}/sessions/${sessionId}/snapshot/reviews/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commentIds }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('snapshot review /submit delivery', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { ctx.cleanup(); });

  it('company scope delivers the compiled message to the master exactly once', async () => {
    const deliverMessage = vi.fn((_sessionId: number, _message: string) => ({ ok: true as const }));
    const app = new Hono();
    mountSnapshotReviewRoutes(app, ctx.deps, {
      scope: 'company',
      listCoderSessionIds: () => [ctx.session.id],
      deliverMessage,
    });

    const { status, body } = await postSubmit(app, 'company', 100, [ctx.comment.id]);

    expect(status).toBe(200);
    expect(deliverMessage).toHaveBeenCalledTimes(1);
    const [sessionIdArg, messageArg] = deliverMessage.mock.calls[0];
    expect(sessionIdArg).toBe(100);
    expect(messageArg).toContain('Snapshot review feedback');
    expect(messageArg).toContain('Use a constant instead of the magic number.');
    expect(body.delivered).toBe(true);
    expect(body.pending).toBeNull();
    // Comment is marked sent.
    expect(ctx.reviewStore.getComment(ctx.comment.id)?.status).toBe('sent');
  });

  it('company scope surfaces an interactive-wait pending without throwing', async () => {
    const deliverMessage = vi.fn(
      (_sessionId: number, _message: string) => ({ ok: false as const, pending: 'interactive_wait' as const }),
    );
    const app = new Hono();
    mountSnapshotReviewRoutes(app, ctx.deps, {
      scope: 'company',
      listCoderSessionIds: () => [ctx.session.id],
      deliverMessage,
    });

    const { status, body } = await postSubmit(app, 'company', 100, [ctx.comment.id]);

    expect(status).toBe(200);
    expect(body.delivered).toBe(false);
    expect(body.pending).toBe('interactive_wait');
  });

  it('coder scope does not server-deliver (no deliverMessage hook)', async () => {
    const app = new Hono();
    mountSnapshotReviewRoutes(app, ctx.deps, { scope: 'coder' });

    const { status, body } = await postSubmit(app, 'coder', ctx.session.id, [ctx.comment.id]);

    expect(status).toBe(200);
    // `delivered: null` signals "not server-delivered" → the coder frontend
    // forwards the returned `message` via the chat stream instead.
    expect(body.delivered).toBeNull();
    expect(typeof body.message).toBe('string');
    expect(ctx.reviewStore.getComment(ctx.comment.id)?.status).toBe('sent');
  });
});
