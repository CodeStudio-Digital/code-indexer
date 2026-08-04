import { pathToFileURL } from 'node:url';

export const SESSION_WORKBENCH_FIXTURE_SEED = 'csw-s0-v1';
export const SESSION_WORKBENCH_FIXTURE_SIZES = Object.freeze([1_000, 10_000]);

const BASE_TIMESTAMP = Date.parse('2026-01-01T00:00:00.000Z');
const PROVIDERS = Object.freeze(['openai', 'anthropic', 'gemini', 'kimi-code']);
const STATUSES = Object.freeze(['idle', 'running', 'waiting', 'completed', 'failed']);

function fixtureUuid(index) {
  const suffix = index.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${suffix}`;
}

/**
 * Deterministic session catalog used by S0/S1/S4 performance checks. It does
 * not touch the real session store and deliberately includes active, archived,
 * favorite, unread and grouped rows.
 */
export function createSessionWorkbenchFixture(count) {
  if (!Number.isSafeInteger(count) || count <= 0 || count > 100_000) {
    throw new TypeError('count must be an integer between 1 and 100000');
  }

  return Array.from({ length: count }, (_, index) => {
    const ordinal = index + 1;
    const projectId = (index % 40) + 1;
    const status = STATUSES[index % STATUSES.length];
    const updatedAt = new Date(BASE_TIMESTAMP + ordinal * 60_000).toISOString();
    return {
      sessionId: fixtureUuid(ordinal),
      projectId,
      workspaceLabel: `Workspace ${projectId.toString().padStart(2, '0')}`,
      groupId: index % 7 === 0 ? null : fixtureUuid(50_000 + (index % 120)),
      title: `Synthetic session ${ordinal.toString().padStart(5, '0')}`,
      provider: PROVIDERS[index % PROVIDERS.length],
      model: `fixture-model-${(index % 6) + 1}`,
      status,
      archived: index % 11 === 0,
      favorite: index % 13 === 0,
      badges: {
        availability: 'available',
        unreadCount: index % 9,
        errorCount: status === 'failed' ? 1 + (index % 3) : 0,
        warningCount: index % 8 === 0 ? 1 : 0,
      },
      run: {
        active: status === 'running' || status === 'waiting',
        waitingForInput: status === 'waiting',
        startedAt: status === 'running' || status === 'waiting' ? updatedAt : null,
        lastEventAt: updatedAt,
      },
      createdAt: new Date(BASE_TIMESTAMP - ordinal * 60_000).toISOString(),
      updatedAt,
    };
  });
}

export function verifySessionWorkbenchFixture(items, expectedCount) {
  if (items.length !== expectedCount) throw new Error(`expected ${expectedCount} rows`);
  if (new Set(items.map((item) => item.sessionId)).size !== expectedCount) {
    throw new Error('fixture session ids must be unique');
  }
  if (!items.some((item) => item.run.active)) throw new Error('fixture must contain active runs');
  if (!items.some((item) => item.archived)) throw new Error('fixture must contain archived sessions');
  if (!items.some((item) => item.favorite)) throw new Error('fixture must contain favorites');
  if (!items.some((item) => item.groupId === null)) throw new Error('fixture must contain ungrouped sessions');
  return true;
}

async function runCli() {
  const requested = process.argv.slice(2).map((value) => Number(value));
  const sizes = requested.length > 0 ? requested : SESSION_WORKBENCH_FIXTURE_SIZES;
  const startedAt = performance.now();
  const results = sizes.map((count) => {
    const itemStartedAt = performance.now();
    const items = createSessionWorkbenchFixture(count);
    verifySessionWorkbenchFixture(items, count);
    return {
      count,
      generationMs: Number((performance.now() - itemStartedAt).toFixed(3)),
      firstId: items[0].sessionId,
      lastId: items.at(-1).sessionId,
      activeRuns: items.filter((item) => item.run.active).length,
    };
  });
  process.stdout.write(`${JSON.stringify({
    seed: SESSION_WORKBENCH_FIXTURE_SEED,
    totalMs: Number((performance.now() - startedAt).toFixed(3)),
    results,
  }, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runCli();
}
