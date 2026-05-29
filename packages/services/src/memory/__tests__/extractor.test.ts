import { describe, it, expect } from 'vitest';
import {
  MemoryExtractor,
  type MemoryDistiller,
  type MemoryWriter,
  type MemoryDedupeSearch,
  type MemoryCandidate,
} from '../extractor.js';
import type { ContextSnapshot, SnapshotCategory } from '@mcp/shared/types.js';

function snap(id: number, title: string, content: string, category: SnapshotCategory = 'note'): ContextSnapshot {
  return {
    id, project_id: 1, title, category, content, tags: '[]',
    created_at: '', updated_at: '', created_by: 'manual', embedding_hash: null,
    source: 'manual', importance: 0.5, last_accessed_at: null, access_count: 0,
  };
}

function fakeWriter() {
  const creates: Array<{ projectId: number; data: Record<string, unknown> }> = [];
  const updates: Array<{ id: number; updates: Record<string, unknown> }> = [];
  const writer: MemoryWriter = {
    async create(projectId, data) { creates.push({ projectId, data: data as Record<string, unknown> }); return {}; },
    async update(id, u) { updates.push({ id, updates: u as Record<string, unknown> }); return {}; },
  };
  return { writer, creates, updates };
}

const fakeSearch = (existing: ContextSnapshot[]): MemoryDedupeSearch => ({
  async searchSnapshotsHybrid() { return existing; },
});

const fakeDistiller = (out: MemoryCandidate[]): MemoryDistiller => ({
  async distill() { return out; },
});

describe('MemoryExtractor', () => {
  it('creates new memory with the given source + importance when no duplicate', async () => {
    const w = fakeWriter();
    const ex = new MemoryExtractor(
      fakeDistiller([{ title: 'Use JWT', content: 'Auth via JWT refresh tokens', category: 'decision', importance: 0.8 }]),
      w.writer, fakeSearch([]),
    );
    const r = await ex.extractAndPersist(1, 'proj', 'session', { decisions: ['use jwt'] });
    expect(r).toEqual({ created: 1, merged: 0, skipped: 0 });
    expect(w.creates[0].data).toMatchObject({ category: 'decision', source: 'session', importance: 0.8 });
  });

  it('applies the per-category importance floor', async () => {
    const w = fakeWriter();
    await new MemoryExtractor(
      fakeDistiller([{ title: 'A decision', content: 'c', category: 'decision', importance: 0.1 }]),
      w.writer, fakeSearch([]),
    ).extractAndPersist(1, 'proj', 'session', {});
    expect(w.creates[0].data.importance).toBe(0.7); // floored: max(0.1, decision floor 0.7)
  });

  it('merges into an existing near-duplicate (same category + similar title)', async () => {
    const w = fakeWriter();
    const ex = new MemoryExtractor(
      fakeDistiller([{ title: 'Use JWT auth', content: 'new detail', category: 'decision', importance: 0.9 }]),
      w.writer, fakeSearch([snap(7, 'Use JWT for auth', 'original content', 'decision')]),
    );
    const r = await ex.extractAndPersist(1, 'proj', 'session', {});
    expect(r).toEqual({ created: 0, merged: 1, skipped: 0 });
    expect(w.updates[0].id).toBe(7);
    expect(String(w.updates[0].updates.content)).toContain('new detail');
    expect(w.creates).toHaveLength(0);
  });

  it('does not merge across different categories', async () => {
    const w = fakeWriter();
    const r = await new MemoryExtractor(
      fakeDistiller([{ title: 'Use JWT auth', content: 'y', category: 'decision', importance: 0.8 }]),
      w.writer, fakeSearch([snap(7, 'Use JWT auth', 'x', 'note')]),
    ).extractAndPersist(1, 'proj', 'session', {});
    expect(r).toMatchObject({ created: 1, merged: 0 });
  });

  it('skips empty candidates', async () => {
    const w = fakeWriter();
    const r = await new MemoryExtractor(
      fakeDistiller([{ title: '   ', content: 'x', category: 'note', importance: 0.9 }]),
      w.writer, fakeSearch([]),
    ).extractAndPersist(1, 'proj', 'session', {});
    expect(r).toEqual({ created: 0, merged: 0, skipped: 1 });
  });

  it('returns zeros when distillation throws (non-fatal)', async () => {
    const w = fakeWriter();
    const r = await new MemoryExtractor(
      { async distill() { throw new Error('llm down'); } },
      w.writer, fakeSearch([]),
    ).extractAndPersist(1, 'proj', 'session', {});
    expect(r).toEqual({ created: 0, merged: 0, skipped: 0 });
    expect(w.creates).toHaveLength(0);
  });
});
