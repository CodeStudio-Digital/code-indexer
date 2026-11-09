import type { CodeIndexDB } from '@mcp/store/db.js';
import type { AgentMemoryType, SnapshotCategory } from '@mcp/shared/types.js';
import type { AgentMemoryService } from './agent-memory-service.js';

const categoryType: Record<SnapshotCategory, AgentMemoryType> = {
  architecture: 'architecture', decision: 'decision', pattern: 'pattern', convention: 'convention',
  todo: 'note', note: 'note', gotcha: 'gotcha', procedure: 'procedure', user: 'preference', feedback: 'preference',
};

/** Explicit, non-destructive import. Originals (including versions/tags/hash refs)
 * remain addressable through source_snapshot_id. Repeats never recreate an
 * imported note, including one the operator later archived or edited. */
export async function importLegacyMemories(db: CodeIndexDB, service: AgentMemoryService,
  projectId: number, snapshotIds: readonly number[], signal?: AbortSignal) {
  if (snapshotIds.length > 100 || snapshotIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('Expected at most 100 positive snapshot ids');
  }
  const results: Array<{ snapshotId: number; status: 'imported' | 'existing' | 'skipped'; memoryId?: number; reason?: string }> = [];
  for (const snapshotId of new Set(snapshotIds)) {
    signal?.throwIfAborted();
    const result = await service.runRelationalWrite(() => db.transaction(() => {
      signal?.throwIfAborted();
      const snapshot = db.getSnapshotById(snapshotId);
      if (!snapshot || snapshot.project_id !== projectId || snapshot.archived_at) {
        return { snapshotId, status: 'skipped' as const, reason: 'snapshot unavailable in this project' };
      }
      const existing = db.findAgentMemoryBySourceSnapshot(snapshotId);
      if (existing) return { snapshotId, status: 'existing' as const, memoryId: existing.id };
      if (!snapshot.title.trim() || !snapshot.content.trim()) {
        return { snapshotId, status: 'skipped' as const, reason: 'empty title or content' };
      }
      const scope = projectId === 0 || snapshot.scope === 'user' ? 'user' : 'project';
      const references = scope === 'user' ? [] : db.raw().prepare(
        'SELECT file_path AS path, file_hash_at_creation AS hash FROM snapshot_files WHERE snapshot_id = ? ORDER BY file_path',
      ).all(snapshotId) as Array<{ path: string; hash: string | null }>;
      const memory = service.create({ scope, projectId, name: snapshot.title, description: snapshot.title,
        type: categoryType[snapshot.category] ?? 'note', content: snapshot.content, source: 'migrated-snapshot',
        sourceSnapshotId: snapshotId, importance: snapshot.importance, referencedFileSnapshots: references });
      db.recordAgentMemoryEvent({ eventType: 'remember', scope, projectId: memory.project_id, memoryId: memory.id,
        kept: 1, meta: { source: 'legacy-import', snapshotId, originalCategory: snapshot.category } });
      return { snapshotId, status: 'imported' as const, memoryId: memory.id };
    }));
    results.push(result);
    // Bound main-thread work even when a project contains many legacy notes.
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return { results, imported: results.filter(row => row.status === 'imported').length,
    existing: results.filter(row => row.status === 'existing').length,
    skipped: results.filter(row => row.status === 'skipped').length };
}
