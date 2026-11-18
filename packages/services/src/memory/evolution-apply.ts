import type { AgentMemoryRow } from '@mcp/shared/types.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { MemoryEvolutionResult, MemoryEvolutionScope } from '@mcp/store/db/agent-memory-evolution.js';
import type { AgentMemoryService } from './agent-memory-service.js';
import { memoryRevision, protectedMemory, type MemoryEvolutionPlan } from './evolution-plan.js';

/** Called inside ONE fenced SQLite transaction, after the network/LLM work. */
export function applyMemoryEvolution(db: CodeIndexDB, service: AgentMemoryService,
  key: MemoryEvolutionScope, sourceRows: AgentMemoryRow[], plan: MemoryEvolutionPlan): Omit<MemoryEvolutionResult, 'reviewed'> {
  const result = { merged: 0, refined: 0, retired: 0, rejected: 0 };
  const snapshots = new Map(sourceRows.map(row => [row.id, row]));
  const claimed = new Set<number>();
  for (const operation of plan.operations) {
    const ids = operation.ids;
    const allIds = [...ids, ...(operation.keepId ? [operation.keepId] : [])];
    const rows = allIds.map(id => db.getAgentMemoryById(id));
    const valid = ids.length > 0 && new Set(allIds).size === allIds.length && rows.every(row => row
      && snapshots.has(row.id) && !claimed.has(row.id) && !row.archived_at
      && row.scope === key.scope && row.project_id === key.projectId
      && memoryRevision(row) === memoryRevision(snapshots.get(row.id)!));
    const targets = rows.slice(0, ids.length) as AgentMemoryRow[];
    if (!valid || targets.some(protectedMemory)) { result.rejected++; continue; }
    if (operation.kind === 'supersede') {
      const keep = rows.at(-1)!;
      if (!operation.keepId || !operation.evidenceQuote || !keep.content.includes(operation.evidenceQuote)
        || targets.some(row => row.id >= keep.id || row.type !== keep.type)) { result.rejected++; continue; }
      for (const row of targets) {
        service.archive(row.id, `evolution:superseded:${keep.id}`);
        db.raw().prepare('UPDATE agent_memory SET superseded_by_id=? WHERE id=?').run(keep.id, row.id);
      }
      result.retired += targets.length;
      db.recordAgentMemoryEvent({ eventType: 'evolution', scope: key.scope, projectId: key.projectId, memoryId: keep.id,
        meta: { kind: operation.kind, inputs: ids, reason: operation.reason } });
    } else {
      if (!operation.content || !operation.name || operation.keepId
        || (operation.kind === 'merge' ? ids.length < 2 : ids.length !== 1)
        || targets.some(row => row.type !== targets[0]!.type)) { result.rejected++; continue; }
      const first = targets[0]!;
      if (targets.length === 1 && operation.content.trim() === first.content.trim()) continue;
      // Preserve historical reference hashes. A conflicting baseline becomes
      // unknown; maintenance must never recapture today's hash as old evidence.
      const refs = new Map<string, string | null>();
      for (const row of targets) for (const ref of JSON.parse(row.referenced_files ?? '[]') as Array<string | { path: string; hash: string | null }>) {
        const path = typeof ref === 'string' ? ref : ref.path;
        const hash = typeof ref === 'string' ? null : ref.hash;
        refs.set(path, refs.has(path) && refs.get(path) !== hash ? null : hash);
      }
      for (const row of targets) service.archive(row.id, 'evolution:pending');
      const fresh = service.create({ scope: key.scope, projectId: key.projectId, name: operation.name,
        type: first.type, content: operation.content, source: 'consolidation',
        importance: Math.max(...targets.map(row => row.importance)), sync: targets.every(row => row.sync === 1),
        referencedFileSnapshots: [...refs].map(([path, hash]) => ({ path, hash })) });
      for (const row of targets) db.raw().prepare('UPDATE agent_memory SET superseded_by_id=?,archived_reason=? WHERE id=?')
        .run(fresh.id, `evolution:${operation.kind}:${fresh.id}`, row.id);
      db.raw().prepare('UPDATE agent_memory SET created_at=?,access_count=?,last_accessed_at=? WHERE id=?')
        .run(targets.map(row => row.created_at).sort()[0], targets.reduce((n, row) => n + row.access_count, 0),
          targets.map(row => row.last_accessed_at).filter(Boolean).sort().at(-1) ?? null, fresh.id);
      result[operation.kind === 'merge' ? 'merged' : 'refined']++;
      db.recordAgentMemoryEvent({ eventType: 'evolution', scope: key.scope, projectId: key.projectId, memoryId: fresh.id,
        meta: { kind: operation.kind, inputs: ids, reason: operation.reason } });
    }
    allIds.forEach(id => claimed.add(id));
  }
  return result;
}
