import { describe, expect, it } from 'vitest';
import { makeStructuralHarness } from './structural-test-harness.js';
import { runStructuralIndex } from '../structural.js';
import { indexFilesStructural } from '../structural-incremental.js';

describe('structural reference replacement and repair', () => {
  it.each(['incremental', 'full'] as const)('%s clears references when the last import/call is removed', async mode => {
    const h = makeStructuralHarness();
    try {
      h.writeFile('target.ts', 'export function target() { return 1; }\n');
      h.writeFile('caller.ts', 'import { target } from "./target";\nexport function caller() { return target(); }\n');
      await h.indexStructural();
      const refs = () => h.db.getSymbolCallers(h.projectId, 'target');
      expect(refs()).toHaveLength(2);
      h.writeFile('caller.ts', 'export const replacement = 42;\n');
      if (mode === 'incremental') {
        expect((await indexFilesStructural(h.db, h.projectId, ['caller.ts'])).errors).toBe(0);
      } else {
        expect((await runStructuralIndex(h.db, h.projectId, { forceReparse: true })).errorCount).toBe(0);
      }
      expect(refs()).toEqual([]);
      expect(h.db.getSymbolsByFile(h.projectId, 'caller.ts').map(s => s.name)).toContain('replacement');

      h.writeFile('caller.ts', 'import { target } from "./target";\ntarget();\n');
      await indexFilesStructural(h.db, h.projectId, ['caller.ts']);
      expect(refs()).toHaveLength(2);
      h.writeFile('caller.ts', '');
      await indexFilesStructural(h.db, h.projectId, ['caller.ts']);
      expect(refs()).toEqual([]);
      expect(h.db.getSymbolsByFile(h.projectId, 'caller.ts')).toEqual([]);
    } finally { h.dispose(); }
  });

  it('repairs stale derived rows without changing source hashes, then resumes cheap scans', async () => {
    const h = makeStructuralHarness();
    try {
      h.writeFile('caller.ts', 'export const replacement = 42;\n');
      await h.indexStructural();
      const file = h.db.getFile(h.projectId, 'caller.ts')!;
      // Simulate rows left by the previous conditional replacement bug.
      h.db.upsertSymbolReferences(h.projectId, file.id, 'caller.ts', [
        { symbol_name: 'removedCall', kind: 'call', line: 200, snippet: 'removedCall()' },
      ]);
      const unchanged = await h.indexStructural();
      expect(unchanged.indexed).toBe(0);
      expect(h.db.getSymbolCallers(h.projectId, 'removedCall')).toHaveLength(1);
      const repaired = await runStructuralIndex(h.db, h.projectId, { forceReparse: true, concurrency: 1 });
      expect(repaired).toMatchObject({ indexed: 1, skipped: 0, errorCount: 0 });
      expect(h.db.getSymbolCallers(h.projectId, 'removedCall')).toEqual([]);
      expect(h.db.getFile(h.projectId, 'caller.ts')!.content_hash).toBe(file.content_hash);
      expect(await h.indexStructural()).toMatchObject({ indexed: 0, skipped: 1, errorCount: 0 });
    } finally { h.dispose(); }
  });
});
