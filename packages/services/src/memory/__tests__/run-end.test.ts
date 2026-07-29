import { describe, it, expect } from 'vitest';
import { createRunEndMemory } from '../run-end.js';
import type { MemoryCandidate, MemoryDistiller, MemoryWriter, MemoryDedupeSearch } from '../extractor.js';
import type { ContextSnapshot } from '@mcp/shared/types.js';
import type { PipelineProviderResolver } from '../../pipelines/index.js';
import { asSessionId } from '@mcp/session-storage';

function fakeWriter() {
  const creates: Array<{ projectId: number; data: Record<string, unknown> }> = [];
  const writer: MemoryWriter = {
    async create(projectId, data) { creates.push({ projectId, data: data as Record<string, unknown> }); return {}; },
    async update() { return {}; },
  };
  return { writer, creates };
}

const fakeSearch = (existing: ContextSnapshot[] = []): MemoryDedupeSearch => ({
  async searchSnapshotsHybrid() { return existing; },
});

const fakeDistiller = (out: MemoryCandidate[]): MemoryDistiller => ({ async distill() { return out; } });
const noop = fakeDistiller([]);

describe('createRunEndMemory', () => {
  it('persists positive facts AND gotcha lessons with source=session', async () => {
    const w = fakeWriter();
    const rem = createRunEndMemory({
      writer: w.writer,
      search: fakeSearch(),
      distillers: {
        positive: fakeDistiller([{ title: 'Use X', content: 'because Y', category: 'decision', importance: 0.8 }]),
        failure: fakeDistiller([{ title: 'Boom', content: 'Symptom… Fix…', category: 'gotcha', importance: 0.7 }]),
        procedure: noop,
      },
    });
    await rem.extractAndPersist(1, 'proj', { primaryRequest: 'do', summary: 's', errorsAndFixes: ['boom -> fixed'] });

    const cats = w.creates.map((c) => c.data.category);
    expect(cats).toContain('decision');
    expect(cats).toContain('gotcha');
    expect(w.creates.every((c) => c.data.source === 'session')).toBe(true);
  });

  it('skips the failure distiller when there are no errors', async () => {
    const w = fakeWriter();
    let failureCalled = false;
    const rem = createRunEndMemory({
      writer: w.writer,
      search: fakeSearch(),
      distillers: {
        positive: fakeDistiller([{ title: 'A', content: 'b', category: 'note', importance: 0.5 }]),
        failure: { async distill() { failureCalled = true; return []; } },
        procedure: noop,
      },
    });
    await rem.extractAndPersist(1, 'proj', { summary: 's' });

    expect(failureCalled).toBe(false);
    expect(w.creates.map((c) => c.data.category)).toEqual(['note']);
  });

  it('skips the positive distiller when there is no fact signal', async () => {
    const w = fakeWriter();
    let positiveCalled = false;
    const rem = createRunEndMemory({
      writer: w.writer,
      search: fakeSearch(),
      distillers: {
        positive: { async distill() { positiveCalled = true; return []; } },
        failure: fakeDistiller([{ title: 'Boom', content: 'c', category: 'gotcha', importance: 0.7 }]),
        procedure: noop,
      },
    });
    await rem.extractAndPersist(1, 'proj', { errorsAndFixes: ['x -> y'] });

    expect(positiveCalled).toBe(false);
    expect(w.creates.map((c) => c.data.category)).toEqual(['gotcha']);
  });

  it('mints a procedure recipe only from a successful run with a command trail', async () => {
    const w = fakeWriter();
    const rem = createRunEndMemory({
      writer: w.writer,
      search: fakeSearch(),
      distillers: {
        positive: noop,
        failure: noop,
        procedure: fakeDistiller([{ title: 'Run tests', content: '## Steps\npnpm test', category: 'procedure', importance: 0.7 }]),
      },
    });
    await rem.extractAndPersist(1, 'proj', { succeeded: true, toolTrail: ['pnpm test'] });
    expect(w.creates.map((c) => c.data.category)).toEqual(['procedure']);
  });

  it('skips the procedure distiller when the run failed or has no command trail', async () => {
    let calls = 0;
    const mk = () => {
      const w = fakeWriter();
      const rem = createRunEndMemory({
        writer: w.writer,
        search: fakeSearch(),
        distillers: { positive: noop, failure: noop, procedure: { async distill() { calls++; return []; } } },
      });
      return { w, rem };
    };
    const a = mk();
    await a.rem.extractAndPersist(1, 'proj', { succeeded: false, toolTrail: ['pnpm test'] }); // failed run
    const b = mk();
    await b.rem.extractAndPersist(1, 'proj', { succeeded: true, toolTrail: [] }); // no commands
    expect(calls).toBe(0);
  });

  it('routes user/feedback candidates to the global user project (0) and logs them separately', async () => {
    const w = fakeWriter();
    const logs: Array<{ projectId: number; entry: Record<string, unknown> }> = [];
    const rem = createRunEndMemory({
      writer: w.writer,
      search: fakeSearch(),
      distillers: {
        positive: fakeDistiller([
          { title: 'Use X', content: 'because Y', category: 'decision', importance: 0.8 },
          { title: 'Keep files small', content: 'under 200 LOC', category: 'feedback', importance: 0.9 },
          { title: 'Solo PT-BR dev', content: 'works alone', category: 'user', importance: 0.8 },
        ]),
        failure: noop,
        procedure: noop,
      },
      distillLog: (projectId, entry) => logs.push({ projectId, entry: entry as Record<string, unknown> }),
    });
    const result = await rem.extractAndPersist(5, 'proj', { summary: 's' });

    const byProject: Record<number, unknown[]> = {};
    for (const c of w.creates) (byProject[c.projectId] ??= []).push(c.data.category);
    expect(byProject[5]).toEqual(['decision']); // project-scope fact → the project
    expect((byProject[0] as string[]).sort()).toEqual(['feedback', 'user']); // user-scope → project 0
    // Project totals exclude the user-scope writes.
    expect(result).toEqual({ created: 1, merged: 0, skipped: 0, hadError: false });
    // Two log rows: the project run + the user-memory pass.
    expect(logs.map((l) => l.projectId).sort()).toEqual([0, 5]);
  });

  it('isConfigured reflects whether the distiller binding resolves', async () => {
    const withResolver = (binding: unknown) =>
      createRunEndMemory({
        writer: fakeWriter().writer,
        search: fakeSearch(),
        resolver: { resolveOrNull: async () => binding } as unknown as PipelineProviderResolver,
      });
    expect(await withResolver({ provider: {} }).isConfigured()).toBe(true);
    expect(await withResolver(null).isConfigured()).toBe(false);
    // No resolver at all (e.g. test/CLI path) → not configured, nothing runs.
    expect(await createRunEndMemory({ writer: fakeWriter().writer, search: fakeSearch() }).isConfigured()).toBe(false);
  });

  it('never throws when a distiller fails (best-effort)', async () => {
    const w = fakeWriter();
    const boom: MemoryDistiller = { async distill() { throw new Error('llm down'); } };
    const rem = createRunEndMemory({
      writer: w.writer,
      search: fakeSearch(),
      distillers: { positive: boom, failure: boom, procedure: boom },
    });
    await expect(
      rem.extractAndPersist(1, 'proj', { summary: 's', errorsAndFixes: ['x -> y'], succeeded: true, toolTrail: ['pnpm test'] }),
    ).resolves.toEqual({ created: 0, merged: 0, skipped: 0, hadError: true });
    expect(w.creates).toHaveLength(0);
  });

  it('promotes durable session notes as literal candidates and logs the pass', async () => {
    const sessionId = asSessionId(
      '00000000-0000-4000-8000-000000000042',
    );
    const w = fakeWriter();
    const logs: Array<{ projectId: number; entry: Record<string, unknown> }> = [];
    const noop: MemoryDistiller = { async distill() { return []; } };
    const rem = createRunEndMemory({
      writer: w.writer,
      search: fakeSearch(),
      distillers: { positive: noop, failure: noop, procedure: noop },
      distillLog: (projectId, entry) => logs.push({ projectId, entry: entry as unknown as Record<string, unknown> }),
    });

    const result = await rem.extractAndPersist(7, 'proj', {
      summary: 's',
      trigger: 'compaction',
      sessionId,
      sessionNotes: [
        { title: 'ABI mismatch on tests', body: 'rebuild with app closed', kind: 'gotcha', pinned: false },
        { title: 'WIP scratch', body: 'ignore me', kind: 'fact', pinned: false },
        { title: '', body: 'no title — dropped', kind: 'decision', pinned: true },
      ],
    });

    // gotcha promotes; plain 'fact' promotes as note; empty title dropped.
    expect(result).toEqual({ created: 2, merged: 0, skipped: 0, hadError: false });
    expect(w.creates.map((c) => c.data.category)).toEqual(['gotcha', 'note']);
    expect(w.creates.map((c) => c.data.source)).toEqual(['session', 'session']);
    expect(logs).toHaveLength(1);
    expect(logs[0].projectId).toBe(7);
    expect(logs[0].entry).toMatchObject({
      trigger: 'compaction',
      sessionId,
      status: 'ok',
      created: 2,
    });
  });
});
