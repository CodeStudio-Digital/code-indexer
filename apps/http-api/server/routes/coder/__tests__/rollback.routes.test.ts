import { Hono } from 'hono';
import { asSessionId, type SessionId } from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';
import { mountCoderRollbackRoute } from '../rollback.js';

const SESSION_ID = asSessionId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

function setup() {
  const rollbackSessionToSeq = vi.fn((sessionId: SessionId, seq: number) => ({
    sessionId,
    seq,
  }));
  const app = new Hono();
  mountCoderRollbackRoute(
    app,
    {
      sessionStore: {
        getSession: (id: SessionId) => id === SESSION_ID ? { id } : null,
        rollbackSessionToSeq,
      },
    } as unknown as ServerDeps,
    { activeRuns: new Map() } as unknown as CoderRuntime,
  );
  return { app, rollbackSessionToSeq };
}

describe('coder rollback route UUID/seq contract', () => {
  it('uses an opaque session UUID and conversation seq', async () => {
    const { app, rollbackSessionToSeq } = setup();
    const response = await app.request(`/api/coder/sessions/${SESSION_ID}/rollback-to-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seq: 17 }),
    });

    expect(response.status).toBe(200);
    expect(rollbackSessionToSeq).toHaveBeenCalledWith(SESSION_ID, 17);
    expect(await response.json()).toMatchObject({ ok: true, sessionId: SESSION_ID, seq: 17 });
  });

  it('does not accept the legacy numeric session/message-id contract', async () => {
    const { app, rollbackSessionToSeq } = setup();
    const numericSession = await app.request('/api/coder/sessions/1/rollback-to-message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seq: 17 }),
    });
    const legacyBody = await app.request(`/api/coder/sessions/${SESSION_ID}/rollback-to-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message_id: 17 }),
    });

    expect(numericSession.status).toBe(400);
    expect(legacyBody.status).toBe(400);
    expect(rollbackSessionToSeq).not.toHaveBeenCalled();
  });
});
