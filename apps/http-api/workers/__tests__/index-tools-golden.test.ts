/**
 * Native index tools (in-process port) against the golden recorded from the
 * MCP bridge (E2), on one fixture with deterministic fakes. Until E5 each case
 * also ran on the bridge; since E6 each case compares the native result with
 * the golden and the fake calls with the explicit list in effects.ts. Opens
 * SQLite: runs only where better-sqlite3 matches the runtime (Electron-as-Node
 * here; see the E2 report). The golden is read-only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setGlobalDocSearch } from '@mcp/code-agent/tools/rag-search-docs.js';
import { documentationBackend } from '@mcp/code-agent/tools/index-docs/doc-backend.js';
import { buildParityFixture, type ParityFixture } from './index-tools-golden/fixture.js';
import { makeFakes } from './index-tools-golden/fakes.js';
import { nativeRoute, type ParityRoute } from './index-tools-golden/route.js';
import { callOnce, Golden, runOnRoute, type ParityCase } from './index-tools-golden/compare.js';
import { CASES_WITH_CALLS, expectedEffects } from './index-tools-golden/effects.js';
import { READ_CASES, T1_CASES, T2_TOOLS } from './index-tools-golden/cases.js';

const golden = new Golden(fileURLToPath(new URL('./fixtures/native-index-parity.golden.json', import.meta.url)));
let fx: ParityFixture;
let main: ParityRoute;
let ghost: ParityRoute;

beforeAll(() => {
  fx = buildParityFixture('reads');
  main = nativeRoute(fx, makeFakes(fx));
  ghost = nativeRoute(fx, makeFakes(fx), 'ghost');
}, 60_000);
afterAll(() => fx?.close());

const marks = (r: ParityRoute) => ({ s: r.fakes.semanticCalls.length, w: r.fakes.wakeCalls.length });
const effects = (r: ParityRoute, m: ReturnType<typeof marks>) => ({
  semantic: r.fakes.semanticCalls.slice(m.s), wake: r.fakes.wakeCalls.slice(m.w),
});

/** native = golden, and the fake calls are the case's expected ones. */
async function compare(c: ParityCase, route: ParityRoute = main) {
  const before = marks(route);
  const value = await runOnRoute(route, c);
  const calls = effects(route, before);
  expect(calls, `${c.id}: fake calls`).toEqual(expectedEffects(c, route.fx));
  expect(golden.formOf(value), `${c.id}: native = golden`).toEqual(golden.expected(c.id));
  return { value, calls };
}

const docCases = (withGlobal: boolean): ParityCase[] => {
  const hooks = withGlobal ? {
    before: (r: ParityRoute) => setGlobalDocSearch(documentationBackend({ db: r.fx.db })),
    after: () => setGlobalDocSearch(null),
  } : {};
  const suffix = withGlobal ? '-global' : '-local';
  return [
    { id: `X-D1${suffix}`, tool: 'mcp__parity_second__rag_search_docs', args: { query: 'segundo' }, ...hooks },
    { id: `X-D2${suffix}`, tool: 'mcp__parity_second__rag_read_doc', args: f => ({ chunk_id: f.ids.chunks[0] }), ...hooks },
    { id: `X-D3${suffix}`, tool: 'mcp__parity_second__rag_doc_outline', args: { collection: 'parity-docs' }, ...hooks },
  ];
};

describe('native index tools: golden (reads)', { timeout: 60_000 }, () => {
  it('has the recorded golden, and every case with expected calls exists', () => {
    expect(golden.missing).toBe(false);
    const ids = new Set(READ_CASES.map(c => c.id));
    for (const id of CASES_WITH_CALLS) expect(ids.has(id), id).toBe(true);
  });

  it.each(READ_CASES.map(c => [c.id, c] as const))('%s', async (_id, c) => {
    await compare(c);
  });

  it('S2 (fts) never asks the semantic owner', async () => {
    const { calls } = await compare({ ...READ_CASES.find(c => c.id === 'S2')!, id: 'S2-calls' });
    expect(calls.semantic).toEqual([]);
  });

  it.each(T1_CASES.map(c => [c.id, c] as const))('%s refuses before dispatch', async (_id, c) => {
    const { value } = await compare(c);
    expect((value as { content: string }).content).toBe('MCP call cancelled before dispatch.');
  });

  it.each(T2_TOOLS)('T2 %s on a project that does not exist', async (tool) => {
    await compare({ id: `T2-${tool}`, tool: `mcp__${tool}`, args: { file_path: 'src/target.ts', pattern: 'x', query: 'x', symbol_name: 'target' } }, ghost);
  });

  it.each([false, true].flatMap(docCases).map(c => [c.id, c] as const))('%s (prefixed documentation)', async (_id, c) => {
    await compare(c);
  });

  it('R18: read_file records file knowledge; a symbol read records none', async () => {
    const abs = join(fx.root, 'src/target.ts');
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(abs, 'utf8');
    for (const [args, expected] of [[{ file_path: 'src/target.ts' }, 'known'], [{ file_path: 'src/target.ts', symbol: 'target' }, 'unknown']] as const) {
      const { ctx } = await callOnce(main, { id: 'R18', tool: 'mcp__read_file', args: { ...args } });
      expect(ctx.fileKnowledge!.state(abs, content), JSON.stringify(args)).toBe(expected);
    }
  });

  it('G9: four parallel greps on the native route equal the sequential answer', async () => {
    const g1 = READ_CASES.find(c => c.id === 'G1')!;
    const sequential = (await callOnce(main, g1)).value;
    const parallel = await Promise.all(Array.from({ length: 4 }, () => callOnce(main, g1)));
    for (const run of parallel) expect(run.value).toEqual(sequential);
  });
});
