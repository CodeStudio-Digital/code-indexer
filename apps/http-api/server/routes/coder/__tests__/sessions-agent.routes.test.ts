/**
 * Unit test for PATCH /api/coder/sessions/:id/agent.
 *
 * Mounts the coder session routes with a STUB sessionStore (no DB) so the
 * test is ABI-free — the /agent handler uses a stub session store. Validates
 * persistence plus the coalesced pending transition for built-in/custom/null
 * targets, idempotence, the unknown-agent 400, and the unknown-session 404.
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { asSessionId, type SessionId } from '@mcp/agent-runtime-contracts';
import { mountCoderSessionsRoutes } from '../sessions.js';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';

vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({
  getCoderWorkerPool: () => ({
    abort: vi.fn(),
    isRunning: () => false,
    getBus: () => null,
  }),
}));

const SESSION_ID = asSessionId('66666666-6666-4666-8666-666666666666');
const MISSING_SESSION_ID = asSessionId('66666666-6666-4666-8666-666666666667');

function setup() {
  const calls: Array<{ id: SessionId; agent: string | null }> = [];
  const messages: Array<{ id: SessionId; message: Record<string, unknown> }> = [];
  const inputs: Array<Record<string, unknown>> = [];
  const pendingTransitions = new Map<SessionId, {
    sessionId: SessionId;
    fromAgent: string | null;
    toAgent: string | null;
  }>();
  const sessions = new Map<SessionId, { id: SessionId; agent: string | null }>([
    [SESSION_ID, { id: SESSION_ID, agent: 'explore' }],
  ]);
  const sessionStore = {
    stageManualAgentTransition: (id: SessionId, agent: string | null) => {
      calls.push({ id, agent });
      const s = sessions.get(id);
      if (!s) return null;
      const existing = pendingTransitions.get(id);
      const fromAgent = existing?.fromAgent ?? s.agent;
      s.agent = agent;
      if (fromAgent === agent) {
        pendingTransitions.delete(id);
        return null;
      }
      const pending = { sessionId: id, fromAgent, toAgent: agent };
      pendingTransitions.set(id, pending);
      return pending;
    },
    getSession: (id: SessionId) => sessions.get(id) ?? null,
    appendMessage: (id: SessionId, message: Record<string, unknown>) => {
      messages.push({ id, message });
      return messages.length;
    },
    recordSessionInput: (input: Record<string, unknown>) => {
      inputs.push(input);
      return input;
    },
    listRecentSessionsGlobal: () => [],
  };
  const customAgent = {
    id: '12345678-abcd-4321-abcd-123456789abc',
    name: 'Security reviewer',
    description: 'Reviews risky changes',
    baseAgentId: 'plan',
    prompt: 'Focus on trust boundaries.',
    skillIds: ['security-review'],
    toolNames: ['read_file'],
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const providerStore = {
    getAppSetting: (key: string) => key === 'coder_custom_agents_v1' ? JSON.stringify([customAgent]) : null,
  };
  const deps = { sessionStore, providerStore } as unknown as ServerDeps;
  const runtime = { activeRuns: new Map() } as unknown as CoderRuntime;
  const app = new Hono();
  mountCoderSessionsRoutes(app, deps, runtime);

  const patchAgent = (id: SessionId, agent: unknown) =>
    app.request(`/api/coder/sessions/${id}/agent`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent }),
    });

  return { app, calls, messages, inputs, pendingTransitions, patchAgent, customAgent };
}

describe('coder PATCH /sessions/:id/agent', () => {
  it('persists a valid agent and stages the reminder for the next run', async () => {
    const { calls, inputs, messages, pendingTransitions, patchAgent } = setup();
    const r = await patchAgent(SESSION_ID, 'build');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { agent: string };
    expect(body.agent).toBe('build');
    expect(calls).toEqual([{ id: SESSION_ID, agent: 'build' }]);
    expect(pendingTransitions.get(SESSION_ID)).toEqual({
      sessionId: SESSION_ID,
      fromAgent: 'explore',
      toAgent: 'build',
    });
    expect(messages).toEqual([]);
    expect(inputs).toEqual([]);
  });

  it('accepts null to clear the column', async () => {
    const { calls, messages, pendingTransitions, patchAgent } = setup();
    const r = await patchAgent(SESSION_ID, null);
    expect(r.status).toBe(200);
    expect(calls).toEqual([{ id: SESSION_ID, agent: null }]);
    expect(pendingTransitions.get(SESSION_ID)).toEqual({
      sessionId: SESSION_ID,
      fromAgent: 'explore',
      toAgent: null,
    });
    expect(messages).toEqual([]);
  });

  it('accepts an enabled custom agent selection id', async () => {
    const { calls, customAgent, messages, pendingTransitions, patchAgent } = setup();
    const selectionId = `custom:${customAgent.id}`;
    const r = await patchAgent(SESSION_ID, selectionId);
    expect(r.status).toBe(200);
    expect(calls).toEqual([{ id: SESSION_ID, agent: selectionId }]);
    expect(pendingTransitions.get(SESSION_ID)).toEqual({
      sessionId: SESSION_ID,
      fromAgent: 'explore',
      toAgent: selectionId,
    });
    expect(messages).toEqual([]);
  });

  it('coalesces selector churn into the final transition only', async () => {
    const { messages, pendingTransitions, patchAgent } = setup();
    await patchAgent(SESSION_ID, 'build');
    await patchAgent(SESSION_ID, 'plan');

    expect(pendingTransitions.get(SESSION_ID)).toEqual({
      sessionId: SESSION_ID,
      fromAgent: 'explore',
      toAgent: 'plan',
    });
    expect(messages).toEqual([]);
  });

  it('cancels the pending reminder when selection returns to the original agent', async () => {
    const { messages, pendingTransitions, patchAgent } = setup();
    await patchAgent(SESSION_ID, 'build');
    await patchAgent(SESSION_ID, 'explore');

    expect(pendingTransitions.has(SESSION_ID)).toBe(false);
    expect(messages).toEqual([]);
  });

  it('does not append another reminder when the selected agent is unchanged', async () => {
    const { calls, inputs, messages, patchAgent } = setup();
    const r = await patchAgent(SESSION_ID, 'explore');
    expect(r.status).toBe(200);
    expect(calls).toEqual([]);
    expect(messages).toEqual([]);
    expect(inputs).toEqual([]);
  });

  it('rejects an unknown agent with 400 and does not persist', async () => {
    const { calls, patchAgent } = setup();
    const r = await patchAgent(SESSION_ID, 'wizard');
    expect(r.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('404s on an unknown session', async () => {
    const { calls, inputs, messages, patchAgent } = setup();
    const r = await patchAgent(MISSING_SESSION_ID, 'build');
    expect(r.status).toBe(404);
    expect(calls).toEqual([]);
    expect(messages).toEqual([]);
    expect(inputs).toEqual([]);
  });
});

describe('coder GET /agents', () => {
  it('appends custom agents with the inherited runtime profile', async () => {
    const { app, customAgent } = setup();
    const response = await app.request('/api/coder/agents');
    expect(response.status).toBe(200);
    const body = await response.json() as { agents: Array<Record<string, unknown>> };
    expect(body.agents).toContainEqual(expect.objectContaining({
      id: `custom:${customAgent.id}`,
      label: customAgent.name,
      baseAgentId: 'plan',
      profile: 'navigate',
      planMode: true,
      custom: true,
    }));
  });
});

describe('coder POST /classify-intent', () => {
  it('uses the Decision Engine specialized routing instead of the legacy tier mapper', async () => {
    const { app } = setup();
    const response = await app.request('/api/coder/classify-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Create a C4 diagram of the architecture' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      agent: 'diagram',
      profile: 'navigate',
      confidence: 'heuristic',
      intent: 'diagram',
      requires_explicit_user_intent: false,
    });
  });

  it('exposes the destructive-intent guard signal for admin recommendations', async () => {
    const { app } = setup();
    const response = await app.request('/api/coder/classify-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Commit the fix and push it' }),
    });
    const body = (await response.json()) as {
      agent: string;
      confidence_score: number;
      requires_explicit_user_intent: boolean;
    };

    expect(body.agent).toBe('admin');
    expect(body.confidence_score).toBeGreaterThan(0);
    expect(body.requires_explicit_user_intent).toBe(true);
  });
});
