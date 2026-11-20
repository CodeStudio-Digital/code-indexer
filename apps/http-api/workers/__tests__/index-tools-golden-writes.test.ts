/**
 * Writes and disk-changing cases against the golden recorded from the MCP
 * bridge (E2): save_memory runs on its own fixture (folder and database) and
 * must leave the expected rows and wake-ups; the overlay cases rewrite a file
 * on disk without reindexing. Until E5 each case also ran on the bridge.
 * Opens SQLite. The golden is read-only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { SessionOverlay } from '@mcp/code-agent/overlay/session-overlay.js';
import { buildParityFixture, TARGET, type ParityFixture } from './index-tools-golden/fixture.js';
import { makeFakes } from './index-tools-golden/fakes.js';
import { nativeRoute, type ParityRoute } from './index-tools-golden/route.js';
import { Golden, runOnRoute, type ParityCase } from './index-tools-golden/compare.js';

const golden = new Golden(fileURLToPath(new URL('./fixtures/native-index-parity-writes.golden.json', import.meta.url)));
const fixtures: ParityFixture[] = [];
let writes: ParityRoute;
let rewritten: ParityRoute;

beforeAll(() => {
  const [forWrites, onDisk] = ['native', 'overlay'].map(label => buildParityFixture(label));
  fixtures.push(forWrites, onDisk);
  writes = nativeRoute(forWrites, makeFakes(forWrites));
  // R16/R17: the file changes on disk after indexing; the overlay marks it dirty.
  writeFileSync(join(onDisk.root, 'src/target.ts'), TARGET.replace('return PUBLIC_LIMIT;', 'return PUBLIC_LIMIT + 1; // edited'));
  rewritten = nativeRoute(onDisk, makeFakes(onDisk));
}, 60_000);
afterAll(() => {
  for (const fx of fixtures) fx.close();
});

async function compare(c: ParityCase, route: ParityRoute) {
  const value = await runOnRoute(route, c);
  expect(golden.formOf(value), `${c.id}: native = golden`).toEqual(golden.expected(c.id));
}

/** What a memory write leaves behind, without ids or timestamps. */
function memoryState(fx: ParityFixture) {
  return fx.db.raw().prepare(`SELECT name, type, scope, content, archived_at IS NULL AS live
    FROM agent_memory WHERE project_id = ? ORDER BY name`).all(fx.main.id);
}

/** The three fixture memories (fixture.ts), ordered by name as memoryState reads them. */
const FIXTURE_MEMORIES = (['convention', 'decision', 'gotcha'] as const).map(type => {
  const i = ['decision', 'gotcha', 'convention'].indexOf(type);
  return { name: `parity-${type}`, type, scope: 'project', live: 1,
    content: `Parity ${type} memory ${i}: the target function returns PUBLIC_LIMIT for every widget.` };
});

const save = { title: 'Paridade', category: 'decision', content: 'abc' };
const dirty = (path: string) => (route: ParityRoute): Partial<ToolContext> => {
  const overlay = new SessionOverlay(route.fx.root);
  overlay.mark(path);
  return { overlay };
};

describe('native index tools: golden (writes)', { timeout: 60_000 }, () => {
  it('has the recorded golden', () => {
    expect(golden.missing).toBe(false);
  });

  it('SV1-SV2: a memory write and its duplicate leave one new row and one wake-up', async () => {
    await compare({ id: 'SV1', tool: 'mcp__save_memory', args: save, once: true }, writes);
    await compare({ id: 'SV2', tool: 'mcp__save_memory', args: save, once: true }, writes);
    // SV1 creates (one durable memory mutation, settled once); SV2 is the same
    // text, skipped without a write (services/memory/extractor.ts). The store
    // keeps the title as a kebab-case slug: 'Paridade' -> 'paridade'
    // (store/src/db/agent-memory.ts create -> slugify in agent-memory-values.ts).
    expect(memoryState(writes.fx)).toEqual([
      { name: 'paridade', type: 'decision', scope: 'project', content: 'abc', live: 1 },
      ...FIXTURE_MEMORIES,
    ]);
    expect(writes.fakes.wakeCalls).toEqual([`memory:project:p${writes.fx.main.id}`]);
  });

  it('SV3: an invalid category fails and writes nothing', async () => {
    const before = memoryState(writes.fx);
    await compare({ id: 'SV3', tool: 'mcp__save_memory', args: { title: 'x', category: 'invalida', content: 'y' }, once: true }, writes);
    expect(memoryState(writes.fx)).toEqual(before);
  });

  it('SV4: an enforced fence routes to the owned port', async () => {
    const fence = () => ({ mutationFence: { mode: 'enforce' } as ToolContext['mutationFence'] });
    await compare({ id: 'SV4', tool: 'mcp__save_memory', args: save, ctx: fence, once: true }, writes);
  });

  it.each([
    ['R16', { file_path: 'src/target.ts' }],
    ['R17', { file_path: 'src/target.ts', symbol: 'target' }],
  ] as const)('%s: a dirty file read through the overlay', async (id, args) => {
    await compare({ id, tool: 'mcp__read_file', args: { ...args }, ctx: dirty('src/target.ts') }, rewritten);
  });
});
