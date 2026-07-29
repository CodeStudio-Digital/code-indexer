/**
 * Tests for dispatchCard (C3) — the shared "resolve role → spawn → assign →
 * move → comment" unit. Fakes only; locks in:
 *   - explicit role skips the recommender entirely,
 *   - a `[role-hint: @x]` comment is preferred over the recommender
 *     (and the LAST hint wins),
 *   - card bookkeeping (assign/move/comment) and visibility events,
 *   - manual source stays silent on the scheduler_* channel,
 *   - skip paths (no role / spawn failure / missing card).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  dispatchCard,
  extractRoleHint,
  type DispatchCardDeps,
} from '../dispatch-card.js';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const CARD_ID = '00000000-0000-4000-8000-000000000007';
const MISSING_CARD_ID = '00000000-0000-4000-8000-000000000099';
const AGENT_RUN_ID = '00000000-0000-4000-8000-000000000042';
const CODER_SESSION_ID = '00000000-0000-4000-8000-000000000009';

function makeCard(over: Record<string, unknown> = {}) {
  return {
    id: CARD_ID,
    title: 'Build login form',
    description: 'React + zod',
    column: 'todo',
    comments: [] as Array<{ content: string; author_role?: string }>,
    ...over,
  };
}

function makeDeps(opts: {
  card?: ReturnType<typeof makeCard> | null;
  recommend?: DispatchCardDeps['recommend'];
  spawnImpl?: () => Promise<{ agentRunId: string; coderSessionId: string }>;
}) {
  const spawn = vi.fn(opts.spawnImpl ?? (async () => ({
    agentRunId: AGENT_RUN_ID,
    coderSessionId: CODER_SESSION_ID,
  })));
  const assignAgent = vi.fn();
  const moveCard = vi.fn();
  const addComment = vi.fn();
  const published: Array<{ event: string; data: Record<string, unknown> }> = [];
  const deps = {
    sessionId: SESSION_ID,
    kanban: {
      getCard: () => (opts.card === undefined ? makeCard() : opts.card),
      assignAgent,
      moveCard,
      addComment,
    },
    subordinates: { spawn },
    recommend: opts.recommend ?? null,
    publish: (event: string, data: Record<string, unknown>) => { published.push({ event, data }); },
  } as unknown as DispatchCardDeps;
  return { deps, spawn, assignAgent, moveCard, addComment, published };
}

describe('extractRoleHint', () => {
  it('returns null without comments or hints', () => {
    expect(extractRoleHint(undefined)).toBeNull();
    expect(extractRoleHint([])).toBeNull();
    expect(extractRoleHint([{ content: 'just a note' }])).toBeNull();
  });

  it('parses the hint and lets the LAST one win', () => {
    expect(extractRoleHint([{ content: '[role-hint: @backend]' }])).toBe('backend');
    expect(
      extractRoleHint([
        { content: '[role-hint: @backend]' },
        { content: 'discussion…' },
        { content: '[role-hint: @qa-lead]' },
      ]),
    ).toBe('qa-lead');
  });
});

describe('dispatchCard', () => {
  it('explicit role skips the recommender and does the full bookkeeping', async () => {
    const recommend = vi.fn(async () => ({ recommendations: [{ role: 'wrong', kind: 'spawn', score: 1 }] }));
    const { deps, spawn, assignAgent, moveCard, addComment, published } = makeDeps({ recommend });

    const result = await dispatchCard(deps, CARD_ID, {
      role: 'frontend',
      source: 'scheduler',
    });

    expect(result).toMatchObject({
      ok: true,
      cardId: CARD_ID,
      role: 'frontend',
      agentRunId: AGENT_RUN_ID,
    });
    expect(recommend).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'frontend',
        task: 'Build login form\n\nReact + zod',
        dispatchSource: 'scheduler',
      }),
    );
    expect(assignAgent).toHaveBeenCalledWith(CARD_ID, AGENT_RUN_ID, 'frontend');
    expect(moveCard).toHaveBeenCalledWith(CARD_ID, 'in_progress');
    expect(addComment).toHaveBeenCalledWith(
      CARD_ID,
      'scheduler',
      AGENT_RUN_ID,
      expect.stringContaining('[AUTO]'),
    );
    expect(published).toContainEqual({
      event: 'scheduler_dispatched',
      data: {
        cardId: CARD_ID,
        role: 'frontend',
        agentRunId: AGENT_RUN_ID,
      },
    });
  });

  it('role-hint comment is preferred over the recommender', async () => {
    const recommend = vi.fn(async () => ({ recommendations: [{ role: 'other', kind: 'spawn', score: 1 }] }));
    const { deps, spawn } = makeDeps({
      card: makeCard({ comments: [{ content: 'plan graph says\n[role-hint: @backend]' }] }),
      recommend,
    });

    const result = await dispatchCard(deps, CARD_ID);

    expect(result).toMatchObject({ ok: true, role: 'backend' });
    expect(recommend).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ role: 'backend' }));
  });

  it('falls back to the recommender when no explicit role or hint exists', async () => {
    const recommend = vi.fn(async () => ({ recommendations: [{ role: 'qa', kind: 'spawn', score: 0.8 }] }));
    const { deps, spawn } = makeDeps({ recommend });

    const result = await dispatchCard(deps, CARD_ID);

    expect(result).toMatchObject({ ok: true, role: 'qa' });
    expect(recommend).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ role: 'qa' }));
  });

  it('skips with no_role when nothing resolves a role (never blind-guesses)', async () => {
    const { deps, spawn, published } = makeDeps({ recommend: async () => ({ recommendations: [] }) });

    const result = await dispatchCard(deps, CARD_ID);

    expect(result).toMatchObject({ ok: false, reason: 'no_role' });
    expect(spawn).not.toHaveBeenCalled();
    expect(published).toContainEqual({
      event: 'scheduler_skipped',
      data: { cardId: CARD_ID, reason: 'no_role' },
    });
  });

  it('maps a recommender crash to recommend_failed', async () => {
    const { deps } = makeDeps({ recommend: async () => { throw new Error('embedding down'); } });
    const result = await dispatchCard(deps, CARD_ID);
    expect(result).toMatchObject({ ok: false, reason: 'recommend_failed' });
  });

  it('maps a spawn throw to spawn_failed with the error message', async () => {
    const { deps, published } = makeDeps({
      spawnImpl: async () => { throw new Error('over cap'); },
    });
    const result = await dispatchCard(deps, CARD_ID, { role: 'frontend' });
    expect(result).toMatchObject({ ok: false, reason: 'spawn_failed', error: 'over cap' });
    expect(published).toContainEqual({
      event: 'scheduler_skipped',
      data: { cardId: CARD_ID, reason: 'spawn_failed' },
    });
  });

  it('returns card_not_found for a missing card', async () => {
    const { deps, spawn } = makeDeps({ card: null });
    const result = await dispatchCard(deps, MISSING_CARD_ID, { role: 'frontend' });
    expect(result).toMatchObject({
      ok: false,
      cardId: MISSING_CARD_ID,
      reason: 'card_not_found',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("manual source: no scheduler_* events, human-authored comment", async () => {
    const { deps, spawn, addComment, published } = makeDeps({});
    const result = await dispatchCard(deps, CARD_ID, {
      role: 'frontend',
      source: 'manual',
    });
    expect(result.ok).toBe(true);
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ dispatchSource: 'manual' }));
    expect(published).toEqual([]); // kanban_* events already narrate manual dispatches
    expect(addComment).toHaveBeenCalledWith(
      CARD_ID,
      'human',
      AGENT_RUN_ID,
      expect.stringContaining('quick-dispatch'),
    );
    expect(addComment).not.toHaveBeenCalledWith(
      CARD_ID,
      'human',
      AGENT_RUN_ID,
      expect.stringContaining('[AUTO]'),
    );
  });
});
