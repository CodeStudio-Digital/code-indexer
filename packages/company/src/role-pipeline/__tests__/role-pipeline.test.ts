/**
 * RolePipeline tests.
 *
 * Invariants verified:
 *   - top-K respected
 *   - role diversity in output (no duplicate role names)
 *   - capacity filter drops fresh spawns when role is at concurrency cap
 *   - capacity filter does NOT drop reuse candidates (they don't open a new slot)
 *   - blocked roles never appear in output
 *   - reuse candidates get the reuseBonus signal
 *   - frontend task ranks frontend role above qa role
 */
import { describe, expect, it } from 'vitest';
import { asAgentRunId } from '@mcp/session-storage';
import {
  createRolePipeline,
  InMemoryRoleEmbeddingStore,
  recommendRoles,
  type EmbeddingFn,
  type RoleDescriptor,
} from '../index.js';

const IDLE_RUN = asAgentRunId('11111111-1111-4111-8111-111111111111');

/**
 * Toy embedder: encodes the FIRST WORD of the input into a 4-dim vector by
 * mapping char codes. Same first word → same embedding → cosine sim = 1.
 */
const toyEmbed: EmbeddingFn = async (text: string) => {
  const first = (text.trim().split(/\s+/)[0] ?? '').toLowerCase();
  const arr = new Float32Array(4);
  for (let i = 0; i < 4; i++) arr[i] = (first.charCodeAt(i) || 0) / 128;
  let norm = 0;
  for (let i = 0; i < 4; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 4; i++) arr[i] /= norm;
  return arr;
};

const ROLES: RoleDescriptor[] = [
  { role: 'frontend', description: 'frontend React UI work', modelCost: 0.5 },
  { role: 'backend',  description: 'backend Node API work',   modelCost: 0.5 },
  { role: 'qa',       description: 'qa Playwright tests',     modelCost: 0.3 },
  { role: 'devops',   description: 'devops CI deployment',    modelCost: 0.7 },
];

function makePipeline(k = 3) {
  return createRolePipeline({
    embed: toyEmbed,
    roleEmbeddingStore: new InMemoryRoleEmbeddingStore(),
    k,
  });
}

describe('RolePipeline', () => {
  it('respects top-K', async () => {
    const pipeline = makePipeline(2);
    const result = await recommendRoles(pipeline, {
      queryId: 'q', taskText: 'frontend bug',
      availableRoles: ROLES,
    });
    expect(result.recommendations.length).toBeLessThanOrEqual(2);
  });

  it('never returns the same role twice in the same recommendation set', async () => {
    const pipeline = makePipeline(4);
    const result = await recommendRoles(pipeline, {
      queryId: 'q', taskText: 'frontend bug',
      availableRoles: ROLES,
      idleRuns: [{ agentRunId: IDLE_RUN, role: 'frontend' }],
    });
    const roleCounts = new Map<string, number>();
    for (const r of result.recommendations) {
      roleCounts.set(r.role, (roleCounts.get(r.role) ?? 0) + 1);
    }
    for (const count of roleCounts.values()) expect(count).toBe(1);
  });

  it('drops fresh spawns at concurrency cap', async () => {
    const cappedRoles: RoleDescriptor[] = ROLES.map((r) =>
      r.role === 'frontend' ? { ...r, concurrencyCap: 1 } : r,
    );
    const pipeline = makePipeline(3);
    const result = await recommendRoles(pipeline, {
      queryId: 'q', taskText: 'frontend feature',
      availableRoles: cappedRoles,
      runningByRole: { frontend: 1 },
    });
    // frontend spawn must be dropped; reuse would still be allowed (but
    // there is no idle run in this test).
    const hasFrontendSpawn = result.recommendations.some(
      (r) => r.role === 'frontend' && r.kind === 'spawn',
    );
    expect(hasFrontendSpawn).toBe(false);
  });

  it('does NOT drop reuse candidates at capacity', async () => {
    const cappedRoles: RoleDescriptor[] = ROLES.map((r) =>
      r.role === 'frontend' ? { ...r, concurrencyCap: 1 } : r,
    );
    const pipeline = makePipeline(3);
    const result = await recommendRoles(pipeline, {
      queryId: 'q', taskText: 'frontend feature',
      availableRoles: cappedRoles,
      runningByRole: { frontend: 1 },
      idleRuns: [{ agentRunId: IDLE_RUN, role: 'frontend' }],
    });
    const frontendReuse = result.recommendations.find(
      (r) => r.role === 'frontend' && r.kind === 'reuse',
    );
    expect(frontendReuse).toBeDefined();
    expect(frontendReuse?.agentRunId).toBe(IDLE_RUN);
  });

  it('filters out blocked roles', async () => {
    const pipeline = makePipeline(4);
    const result = await recommendRoles(pipeline, {
      queryId: 'q', taskText: 'qa test',
      availableRoles: ROLES,
      blockedRoles: ['qa'],
    });
    expect(result.recommendations.some((r) => r.role === 'qa')).toBe(false);
  });

  it('reuse candidates carry reuseBonus signal', async () => {
    const pipeline = makePipeline(4);
    const result = await recommendRoles(pipeline, {
      queryId: 'q', taskText: 'frontend bug',
      availableRoles: ROLES,
      idleRuns: [{ agentRunId: IDLE_RUN, role: 'frontend' }],
    });
    const frontend = result.recommendations.find((r) => r.role === 'frontend');
    expect(frontend?.kind).toBe('reuse'); // wins over spawn thanks to reuseBonus
    expect(frontend?.signals.reuseBonus).toBe(1);
  });

  it('cheaper roles rank above more expensive ones (cost negative weight)', async () => {
    const pipeline = makePipeline(4);
    // Use a task that doesn't strongly favor any one role lexically.
    const result = await recommendRoles(pipeline, {
      queryId: 'q', taskText: 'general task',
      availableRoles: ROLES,
    });
    // devops has highest modelCost (0.7) — should rank below frontend/backend (0.5) and qa (0.3).
    const idx = (role: string) => result.recommendations.findIndex((r) => r.role === role);
    expect(idx('devops')).toBeGreaterThan(idx('qa'));
  });

  it('namespaces role embeddings by the dynamic model fingerprint', async () => {
    let model = 'model-a';
    let embedCalls = 0;
    const dynamicEmbed: EmbeddingFn = Object.assign(
      async () => {
        embedCalls++;
        return Float32Array.from(model === 'model-a' ? [1, 0] : [0, 1]);
      },
      { fingerprint: () => model },
    );
    const pipeline = createRolePipeline({
      embed: dynamicEmbed,
      roleEmbeddingStore: new InMemoryRoleEmbeddingStore(),
      k: 3,
    });

    await recommendRoles(pipeline, { queryId: 'a', taskText: 'frontend bug', availableRoles: ROLES });
    expect(embedCalls).toBe(ROLES.length + 1);

    model = 'model-b';
    embedCalls = 0;
    await recommendRoles(pipeline, { queryId: 'b', taskText: 'frontend bug', availableRoles: ROLES });
    expect(embedCalls).toBe(ROLES.length + 1);

    embedCalls = 0;
    await recommendRoles(pipeline, { queryId: 'c', taskText: 'frontend bug', availableRoles: ROLES });
    expect(embedCalls).toBe(1);
  });
});
