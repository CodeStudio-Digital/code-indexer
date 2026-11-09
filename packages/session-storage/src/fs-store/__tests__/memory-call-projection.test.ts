import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, appendFile, rm, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { canonicalJson } from '../../atomic-file.js';
import { MemoryCallProjection } from '../memory-call-projection.js';

function journal() {
  let seq = 0, previous: string | null = null;
  return (tool?: string, noise = '', truncate?: number) => {
    seq += 1;
    const unsigned = { schema_version: 1, seq, operation_id: `op-${seq}`, request_hash: 'fixture',
      committed_at: '2026-11-04T12:00:00.000Z', prev_hash: previous, artifacts: [],
      payload: { schema_version: 1, type: 'coder.turn', request_key: `request-${seq}`, messages: [], message_patches: [],
        tool_calls: tool ? [{ message_seq: seq, tool_name: tool, output: { created_at: '2026-11-04T12:00:00.000Z' } }] : [],
        ...(truncate == null ? {} : { truncate_from_seq: truncate }), noise } };
    previous = createHash('sha256').update(canonicalJson(unsigned)).digest('hex');
    return JSON.stringify({ ...unsigned, hash: previous }) + '\n';
  };
}

describe('incremental memory call projection', () => {
  it('parses only appended commits in a 12MiB history; handles partial writes, rollback and rewrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memory-projection-'));
    const path = join(root, 'conversation.jsonl');
    try {
      const line = journal();
      const baseline = Array.from({ length: 240 }, (_, index) => line(index % 60 === 0 ? 'remember' : undefined, 'x'.repeat(52_428))).join('');
      await writeFile(path, baseline);
      const projection = new MemoryCallProjection();
      const start = performance.now();
      const cold = await projection.read(path);
      const coldMs = performance.now() - start;
      expect(cold.commitsParsed).toBe(240);
      expect(cold.calls).toHaveLength(4);
      const warmStart = performance.now();
      const warm = await projection.read(path);
      const warmMs = performance.now() - warmStart;
      expect(warm.bytesRead).toBe(0); expect(warm.commitsParsed).toBe(0);
      const delta = line('mcp__save_memory') + line('mcp__search_memory');
      await appendFile(path, delta);
      const appendStart = performance.now();
      const appended = await projection.read(path);
      const appendMs = performance.now() - appendStart;
      expect(appended.reset).toBe(false); expect(appended.commitsParsed).toBe(2);
      expect(appended.bytesRead).toBeLessThan(Buffer.byteLength(delta) + 4096);
      expect(appended.calls).toHaveLength(6);
      await appendFile(path, line(undefined, '', 241));
      const rolledBack = await projection.read(path);
      expect(rolledBack.commitsParsed).toBe(1); expect(rolledBack.calls).toHaveLength(4);
      const partial = line('remember');
      await appendFile(path, partial.slice(0, -2));
      expect((await projection.read(path)).commitsParsed).toBe(0);
      await appendFile(path, partial.slice(-2));
      expect((await projection.read(path)).calls).toHaveLength(5);
      await writeFile(path, journal()('ignoredx'));
      const rewritten = await projection.read(path);
      expect(rewritten.reset).toBe(true); expect(rewritten.calls).toHaveLength(0);
      await writeFile(path, journal()('remember'));
      const changed = new Date(Date.now() + 1000); await utimes(path, changed, changed);
      expect((await projection.read(path)).calls).toHaveLength(1);
      const evidence = resolve('.tmp/knowledge-fixes-2026-11-04/memory');
      await mkdir(evidence, { recursive: true });
      await writeFile(join(evidence, 'projection-benchmark.json'), JSON.stringify({
        synthetic: true, historyBytes: Buffer.byteLength(baseline),
        cold: { bytesRead: cold.bytesRead, commitsParsed: cold.commitsParsed, ms: coldMs },
        unchanged: { bytesRead: warm.bytesRead, commitsParsed: warm.commitsParsed, ms: warmMs },
        append: { bytesAppended: Buffer.byteLength(delta), bytesRead: appended.bytesRead, commitsParsed: appended.commitsParsed, ms: appendMs },
        rollbackVerified: true, partialLineVerified: true, shrinkAndSameSizeRewriteVerified: true,
      }, null, 2));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
