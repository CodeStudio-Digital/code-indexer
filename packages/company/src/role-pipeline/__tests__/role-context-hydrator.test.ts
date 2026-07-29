/**
 * Tests for C4 — RoleContextHydrator.
 *
 * Locks in:
 *   - fetcher results populate `candidate.roleContext`
 *   - null fetcher result keeps candidate unchanged
 *   - fetcher rejection → CandidateResult.ok=false (best-effort)
 *   - timeout → error path (no hang)
 *   - parallel execution per candidate
 *   - integration via pipeline: roleContext appears on selected candidates
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ContextFetcher,
  RoleContextHydrator,
  RoleContextPayload,
  createRolePipeline,
  recommendRoles,
  InMemoryRoleEmbeddingStore,
  type EmbeddingFn,
  type RoleCandidate,
  type RoleDescriptor,
  type RolePipelineQuery,
} from '../index.js';

const KANBAN_CARD_ID = '00000000-0000-4000-8000-000000000001';

function spawnCandidate(role: RoleDescriptor): RoleCandidate {
  return {
    candidateId: `spawn::${role.role}`,
    kind: 'spawn',
    role,
    signals: {},
    score: 0,
  };
}

function role(name: string): RoleDescriptor {
  return { role: name, description: `${name} role` };
}

const emptyQuery: RolePipelineQuery = {
  queryId: 'q1',
  taskText: 'task',
  availableRoles: [],
};

const toyEmbed: EmbeddingFn = async (text: string) => {
  const arr = new Float32Array(4);
  for (let i = 0; i < 4; i++) arr[i] = (text.toLowerCase().charCodeAt(i) || 0) / 128;
  let norm = 0;
  for (let i = 0; i < 4; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 4; i++) arr[i] /= norm;
  return arr;
};

describe('RoleContextHydrator', () => {
  it('populates roleContext from a successful fetch', async () => {
    const payload: RoleContextPayload = {
      relevantFiles: [{ path: 'src/x.ts', score: 0.9 }],
      kanbanCards: [{ id: KANBAN_CARD_ID, title: 'card-A' }],
      notes: 'fresh context',
    };
    const fetcher: ContextFetcher = async () => payload;
    const hydrator = new RoleContextHydrator({ fetcher });
    const candidates = [spawnCandidate(role('frontend'))];

    const results = await hydrator.hydrate(emptyQuery, candidates);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    if (results[0].ok) {
      expect(results[0].candidate.roleContext).toEqual(payload);
    }
  });

  it('null fetcher result leaves the candidate roleContext undefined', async () => {
    const fetcher: ContextFetcher = async () => null;
    const hydrator = new RoleContextHydrator({ fetcher });
    const candidates = [spawnCandidate(role('frontend'))];

    const results = await hydrator.hydrate(emptyQuery, candidates);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    if (results[0].ok) {
      expect(results[0].candidate.roleContext).toBeUndefined();
    }
  });

  it('fetcher error → CandidateResult.ok=false (best-effort)', async () => {
    const fetcher: ContextFetcher = async () => {
      throw new Error('upstream HybridSearch is down');
    };
    const hydrator = new RoleContextHydrator({ fetcher });
    const candidates = [spawnCandidate(role('frontend'))];

    const results = await hydrator.hydrate(emptyQuery, candidates);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    if (!results[0].ok) {
      expect(results[0].error).toContain('upstream HybridSearch');
    }
  });

  it('per-candidate timeout is enforced', async () => {
    // Slow fetcher: 5s; timeout 50ms — should fail with timeout error.
    const fetcher: ContextFetcher = () => new Promise((resolve) => setTimeout(() => resolve(null), 5000));
    const hydrator = new RoleContextHydrator({ fetcher, timeoutMs: 50 });
    const candidates = [spawnCandidate(role('frontend'))];

    const results = await hydrator.hydrate(emptyQuery, candidates);
    expect(results[0].ok).toBe(false);
    if (!results[0].ok) {
      expect(results[0].error).toContain('timeout');
    }
  });

  it('hydrates multiple candidates in parallel', async () => {
    const starts: number[] = [];
    const fetcher: ContextFetcher = async (c) => {
      starts.push(Date.now());
      await new Promise((r) => setTimeout(r, 50));
      return { notes: c.role.role };
    };
    const hydrator = new RoleContextHydrator({ fetcher });
    const candidates = [
      spawnCandidate(role('a')),
      spawnCandidate(role('b')),
      spawnCandidate(role('c')),
    ];

    const t0 = Date.now();
    const results = await hydrator.hydrate(emptyQuery, candidates);
    const elapsed = Date.now() - t0;

    // Parallel: total < N * each. If sequential it would be ~150ms+.
    expect(elapsed).toBeLessThan(140);
    expect(results.map((r) => (r.ok ? r.candidate.roleContext?.notes : null))).toEqual(['a', 'b', 'c']);
  });
});

describe('RolePipeline integration with C4', () => {
  it('does NOT wire post-selection hydrator when no fetcher is provided (backward compat)', async () => {
    const pipeline = createRolePipeline({
      embed: toyEmbed,
      roleEmbeddingStore: new InMemoryRoleEmbeddingStore(),
      // roleContextFetcher intentionally omitted
    });
    const result = await recommendRoles(pipeline, {
      queryId: 'q1',
      taskText: 'something',
      availableRoles: [role('frontend'), role('backend'), role('qa')],
    });
    expect(result.recommendations.length).toBeGreaterThan(0);
    // No roleContext on any signals — pre-C4 shape.
    for (const r of result.recommendations) {
      // signals object exists but no context-related fields.
      expect((r.signals as { roleContext?: unknown }).roleContext).toBeUndefined();
    }
  });

  it('populates roleContext on selected candidates when fetcher is wired', async () => {
    const fetcher = vi.fn<ContextFetcher>(async (c) => ({
      relevantFiles: [{ path: `for/${c.role.role}.ts` }],
      notes: `prefetched for ${c.role.role}`,
    }));
    const pipeline = createRolePipeline({
      embed: toyEmbed,
      roleEmbeddingStore: new InMemoryRoleEmbeddingStore(),
      roleContextFetcher: fetcher,
      k: 2,
    });

    const result = await pipeline.execute({
      queryId: 'q1',
      taskText: 'task',
      availableRoles: [role('frontend'), role('backend'), role('qa'), role('design')],
      k: 2,
    });

    expect(result.selected).toHaveLength(2);
    for (const c of result.selected) {
      expect(c.roleContext).toBeDefined();
      expect(c.roleContext?.notes).toContain('prefetched');
    }
    // Fetcher called exactly once per SELECTED candidate (post-selection only).
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('a fetcher failure does NOT block the spawn (selected unchanged, roleContext absent)', async () => {
    const fetcher: ContextFetcher = async () => {
      throw new Error('flaky external service');
    };
    const pipeline = createRolePipeline({
      embed: toyEmbed,
      roleEmbeddingStore: new InMemoryRoleEmbeddingStore(),
      roleContextFetcher: fetcher,
      k: 2,
    });

    const result = await pipeline.execute({
      queryId: 'q1',
      taskText: 'task',
      availableRoles: [role('a'), role('b'), role('c')],
      k: 2,
    });

    expect(result.selected).toHaveLength(2);
    for (const c of result.selected) {
      // Failed fetch → roleContext stays undefined; spawn proceeds.
      expect(c.roleContext).toBeUndefined();
    }
  });
});
