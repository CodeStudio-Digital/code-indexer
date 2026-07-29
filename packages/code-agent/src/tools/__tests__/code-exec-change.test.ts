/**
 * `change` sandbox API (the interrogable diff) over a stubbed
 * SessionChangesPort + nested-call function — no DB, no registry.
 */
import { describe, it, expect } from 'vitest';
import { buildChangeSandboxApi } from '../code-exec-change.js';
import { computeHunks } from '@mcp/services/services/snapshot-hunks.js';
import type { FileDiff } from '@mcp/services/services/session-snapshots.js';

const BEFORE = 'export function applyPatch(a: string) {\n  return a;\n}\n';
const AFTER = 'export function applyPatch(a: string, c: number) {\n  return a + c;\n}\n';
const BASELINE_ID = '00000000-0000-4000-8000-000000000007';

function makeDiff(
  filePath: string,
  before: string,
  after: string,
  id: string,
): FileDiff<string> {
  return {
    baseline: { id, filePath, existedBefore: true, oversized: false, status: 'active' },
    hunks: computeHunks(before, after).map((h) => ({ ...h, decision: 'pending' as const })),
    diffDisabled: false,
    currentContent: after,
  };
}

function api(calls: Array<{ name: string; args: Record<string, unknown> }> = []) {
  const diff = makeDiff('src/apply.ts', BEFORE, AFTER, BASELINE_ID);
  const port = {
    getDiffs: async () => [diff],
    getBeforeContent: async (baselineId: string) =>
      baselineId === BASELINE_ID ? BEFORE : null,
  };
  const callTool = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return JSON.stringify({
      references: [{ file_path: 'src/runner.ts', line: 88, context: 'applyPatch(x)' }],
    });
  };
  return buildChangeSandboxApi(port, callTool, 'my-project') as Record<
    string,
    (...a: unknown[]) => Promise<unknown>
  >;
}

describe('change sandbox API', () => {
  it('files() returns shape-classified summaries with anchors', async () => {
    const files = (await api().files()) as Array<Record<string, unknown>>;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: 'src/apply.ts',
      baselineId: BASELINE_ID,
      pendingHunks: 1,
    });
    expect(files[0].shapes).toHaveProperty('logic', 1);
  });

  it('hunks(path) returns structured pending hunks and rejects unknown paths', async () => {
    const hunks = (await api().hunks('src/apply.ts')) as Array<Record<string, unknown>>;
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toHaveProperty('fingerprint');
    expect(hunks[0]).toHaveProperty('shape', 'logic');
    await expect(api().hunks('src/nope.ts')).rejects.toThrow(/not changed this session/);
  });

  it('raw() and symbol() expose both sides of the change', async () => {
    const raw = (await api().raw('src/apply.ts')) as { before: string; after: string };
    expect(raw.before).toContain('(a: string)');
    expect(raw.after).toContain('c: number');
    const sym = (await api().symbol('src/apply.ts', 'applyPatch')) as {
      before: string;
      after: string;
    };
    expect(sym.before).toContain('return a;');
    expect(sym.after).toContain('return a + c;');
  });

  it('callers() delegates to mcp__find_references through the nested-call path', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const refs = (await api(calls).callers('applyPatch')) as Array<Record<string, unknown>>;
    expect(calls[0]).toMatchObject({
      name: 'mcp__find_references',
      args: { project_name: 'my-project', symbol_name: 'applyPatch', format: 'json' },
    });
    expect(refs[0]).toMatchObject({ filePath: 'src/runner.ts', line: 88 });
  });

  it('search() scans the requested side of the change', async () => {
    const beforeHits = (await api().search('return a;', { side: 'before' })) as unknown[];
    const afterHits = (await api().search('return a;', { side: 'after' })) as unknown[];
    expect(beforeHits).toHaveLength(1);
    expect(afterHits).toHaveLength(0);
  });

  it('absences() reports untouched references of the changed signature', async () => {
    const entries = (await api().absences()) as Array<{
      change: { symbolName: string };
      references: Array<{ filePath: string }>;
    }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].change.symbolName).toBe('applyPatch');
    expect(entries[0].references[0].filePath).toBe('src/runner.ts');
  });
});
