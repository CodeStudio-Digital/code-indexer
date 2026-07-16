import type {
  AgentMemoryRow,
  AgentMemoryScope,
  AgentMemoryType,
  ContextSnapshot,
  SnapshotCategory,
} from '@mcp/shared/types.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { MemoryDedupeSearch, MemoryWriter } from './extractor.js';
import type { AgentMemoryService } from './agent-memory-service.js';

/**
 * Write-path adapters that re-home the existing (tested) `MemoryExtractor` /
 * `createRunEndMemory` machinery onto the dedicated `agent_memory` table WITHOUT
 * touching them — they depend only on the structural `MemoryWriter` /
 * `MemoryDedupeSearch` interfaces, so we satisfy those over agent_memory.
 *
 * Scope is derived from `project_id` (the existing run-end convention: project 0
 * = global user memory, any other id = that project), so the extractor's
 * project/user split keeps working unchanged.
 */

/** Distiller `SnapshotCategory` → closed agent-memory `type`. */
const CATEGORY_TO_TYPE: Record<SnapshotCategory, AgentMemoryType> = {
  architecture: 'architecture',
  decision: 'decision',
  pattern: 'pattern',
  convention: 'convention',
  procedure: 'procedure',
  gotcha: 'gotcha',
  user: 'preference',
  feedback: 'preference',
  todo: 'note',
  note: 'note',
};

/** Agent-memory `type` → `SnapshotCategory` for dedupe comparison (round-trips
 *  the overlapping kinds losslessly; preference→user, external_pointer→note). */
const TYPE_TO_CATEGORY: Record<AgentMemoryType, SnapshotCategory> = {
  preference: 'user',
  convention: 'convention',
  procedure: 'procedure',
  architecture: 'architecture',
  gotcha: 'gotcha',
  external_pointer: 'note',
  pattern: 'pattern',
  decision: 'decision',
  note: 'note',
};

export function scopeForProject(projectId: number): AgentMemoryScope {
  return projectId === 0 ? 'user' : 'project';
}

/** Satisfies `MemoryWriter` over `agent_memory` with embed-on-write and
 *  logical-immutable updates (content change ⇒ archive+create). */
export class AgentMemoryWriter implements MemoryWriter {
  constructor(
    private readonly db: CodeIndexDB,
    private readonly service: AgentMemoryService,
  ) {}

  async create(
    projectId: number,
    data: {
      title: string;
      category: SnapshotCategory;
      content: string;
      source: string;
      importance: number;
      referencedFiles?: string[];
    },
  ): Promise<AgentMemoryRow> {
    const scope = scopeForProject(projectId);
    const row = this.service.create({
      scope,
      projectId,
      name: data.title,
      type: CATEGORY_TO_TYPE[data.category] ?? 'note',
      content: data.content,
      source: data.source,
      importance: data.importance,
      referencedFiles: data.referencedFiles,
    });
    await this.service.embedAndUpsert(row).catch(() => undefined);
    return row;
  }

  async update(
    id: number,
    updates: { content?: string; projectId?: number; importance?: number },
  ): Promise<AgentMemoryRow | undefined> {
    const old = this.db.getAgentMemoryById(id);
    if (!old) return undefined;
    // Content change → logical-immutable replace (archive old + create fresh,
    // earliest created_at preserved), then swap the vectors.
    if (updates.content != null && updates.content !== old.content) {
      const fresh = this.service.replace(id, {
        scope: old.scope,
        projectId: old.project_id,
        name: old.name,
        description: old.description,
        type: old.type,
        content: updates.content,
        source: old.source,
        importance: updates.importance ?? old.importance,
      });
      await this.service.removeVectors(old.id, old.project_id).catch(() => undefined);
      await this.service.embedAndUpsert(fresh).catch(() => undefined);
      return fresh;
    }
    // Importance-only corroboration → cheap metadata bump (no archive churn).
    if (updates.importance != null) this.db.setAgentMemoryImportance(id, updates.importance);
    return old;
  }
}

/** Satisfies `MemoryDedupeSearch` over `agent_memory` (scope from project id). */
export class AgentMemoryDedupeSearch implements MemoryDedupeSearch {
  constructor(private readonly service: AgentMemoryService) {}

  async searchSnapshotsHybrid(
    projectId: number,
    _projectName: string,
    query: string,
    limit: number,
  ): Promise<ContextSnapshot[]> {
    const hits = await this.service.search(scopeForProject(projectId), projectId, query, limit);
    return hits.map(toSnapshotShape);
  }
}

/** Map an agent-memory row to the minimal `ContextSnapshot` shape the dedupe
 *  step reads (id/title/content/category/importance). */
function toSnapshotShape(row: AgentMemoryRow): ContextSnapshot {
  return {
    id: row.id,
    project_id: row.project_id,
    title: row.name,
    category: TYPE_TO_CATEGORY[row.type] ?? 'note',
    content: row.content,
    tags: '[]',
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.source,
    embedding_hash: row.embedding_hash,
    source: row.source,
    importance: row.importance,
    last_accessed_at: row.last_accessed_at,
    access_count: row.access_count,
    archived_at: row.archived_at,
  };
}
