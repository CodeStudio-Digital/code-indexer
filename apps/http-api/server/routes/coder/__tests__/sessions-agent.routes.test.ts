/**
 * Unit test for PATCH /api/coder/sessions/:id/agent.
 *
 * Mounts the coder session routes with a STUB sessionStore (no DB) so the
 * test is ABI-free — the /agent handler only touches setSessionAgent +
 * getSession. Validates persistence of a known agent, null-clear, the
 * unknown-agent 400, and the unknown-session 404.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mountCoderSessionsRoutes } from '../sessions.js';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';

function setup() {
  const calls: Array<{ id: number; agent: string | null }> = [];
  const sessions = new Map<number, { id: number; agent: string | null }>([
    [1, { id: 1, agent: 'explore' }],
  ]);
  const sessionStore = {
    setSessionAgent: (id: number, agent: string | null) => {
      calls.push({ id, agent });
      const s = sessions.get(id);
      if (s) s.agent = agent;
    },
    getSession: (id: number) => sessions.get(id) ?? null,
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

  const patchAgent = (id: number, agent: unknown) =>
    app.request(`/api/coder/sessions/${id}/agent`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent }),
    });

  return { app, calls, patchAgent, customAgent };
}

describe('coder PATCH /sessions/:id/agent', () => {
  it('persists a valid agent and echoes the updated session', async () => {
    const { calls, patchAgent } = setup();
    const r = await patchAgent(1, 'build');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { agent: string };
    expect(body.agent).toBe('build');
    expect(calls).toEqual([{ id: 1, agent: 'build' }]);
  });

  it('accepts null to clear the column', async () => {
    const { calls, patchAgent } = setup();
    const r = await patchAgent(1, null);
    expect(r.status).toBe(200);
    expect(calls).toEqual([{ id: 1, agent: null }]);
  });

  it('accepts an enabled custom agent selection id', async () => {
    const { calls, customAgent, patchAgent } = setup();
    const selectionId = `custom:${customAgent.id}`;
    const r = await patchAgent(1, selectionId);
    expect(r.status).toBe(200);
    expect(calls).toEqual([{ id: 1, agent: selectionId }]);
  });

  it('rejects an unknown agent with 400 and does not persist', async () => {
    const { calls, patchAgent } = setup();
    const r = await patchAgent(1, 'wizard');
    expect(r.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('404s on an unknown session', async () => {
    const { patchAgent } = setup();
    const r = await patchAgent(999, 'build');
    expect(r.status).toBe(404);
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
