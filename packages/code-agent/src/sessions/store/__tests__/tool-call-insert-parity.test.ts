/**
 * Tripwire: the dbWriter worker mirrors `persistAssistantTurn` by hand
 * ("keep in sync if the schema changes") — and drifted twice already
 * (refusal_kind and output_chars_shaped were missing from its INSERT,
 * silently dropping telemetry whenever MCP_DB_WORKER=1).
 *
 * This test parses the actual INSERT column lists out of both source files
 * and fails the moment they diverge. Editing either INSERT now forces you
 * to edit the other (or consciously update this test).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function insertColumnSets(sourcePath: URL): string[][] {
  const src = readFileSync(fileURLToPath(sourcePath), 'utf8');
  const out: string[][] = [];
  const re = /INSERT INTO coder_tool_calls\s*\(([^)]+)\)/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    out.push(
      m[1]
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
        .sort(),
    );
  }
  return out;
}

const storeUrl = new URL('../messages.ts', import.meta.url);
const workerUrl = new URL('../../../../../indexer/src/workers/dbWriter/worker.ts', import.meta.url);

describe('coder_tool_calls INSERT parity (store vs dbWriter mirror)', () => {
  it('every INSERT writes the exact same column set', () => {
    const storeSets = insertColumnSets(storeUrl);
    const workerSets = insertColumnSets(workerUrl);

    expect(storeSets.length).toBeGreaterThanOrEqual(1);
    expect(workerSets.length).toBeGreaterThanOrEqual(1);

    const reference = storeSets[0];
    for (const set of [...storeSets, ...workerSets]) {
      expect(set).toEqual(reference);
    }
  });

  it('the column set includes the telemetry columns that drifted before', () => {
    const reference = insertColumnSets(storeUrl)[0];
    expect(reference).toContain('refusal_kind');
    expect(reference).toContain('output_chars_shaped');
    expect(reference).toContain('output_format');
    expect(reference).toContain('structured_output_chars');
    expect(reference).toContain('guard_action');
    expect(reference).toContain('guard_origin_tool_use_id');
    expect(reference).toContain('delivered');
  });
});
