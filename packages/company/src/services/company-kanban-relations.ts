
import { object } from './company-session-file-values.js';

import { assertUuid, asAgentRunId } from '@mcp/session-storage';

import { randomUUID } from 'node:crypto';

import type { KanbanCardAgent, KanbanCardDependency, KanbanChecklistItem, KanbanComment } from '@mcp/company/types.js';
import { CompanySessionFileBase } from './company-session-file-base.js';
import { CompanyKanbanFiles } from './company-kanban-files.js';

export class CompanyKanbanRelations {
  constructor(private readonly context: CompanySessionFileBase, private readonly kanban: CompanyKanbanFiles) {}

  addKanbanCommentSync(
    cardId: string,
    authorRole: string,
    agentRunId: string | null,
    content: string,
  ): KanbanComment {
    const normalizedAgentRunId =
      agentRunId == null ? null : asAgentRunId(agentRunId);
    const comment = {
      id: randomUUID(),
      author_role: authorRole,
      agent_run_id: normalizedAgentRunId,
      content,
      created_at: new Date().toISOString(),
    };
    const updated = this.kanban.replaceKanbanCardSync(cardId, (_card, data) => ({
      ...data,
      comments: [...(Array.isArray(data.comments) ? data.comments : []), comment],
    }));
    if (!updated) throw new Error(`Unknown Company kanban card ${cardId}`);
    return updated.comments.find((row) => row.id === comment.id)!;
  }

  updateKanbanChecklistSync(
    cardId: string,
    items: Array<{ id?: string; text: string; checked: boolean }>,
  ): KanbanChecklistItem[] {
    const current = this.kanban.getKanbanCardFullSync(cardId);
    if (!current) throw new Error(`Unknown Company kanban card ${cardId}`);
    const byId = new Map(current.checklist.map((item) => [item.id, item]));
    const next = items.map((item, index) => {
      if (item.id) {
        const normalized = assertUuid(item.id, 'Company checklist item id');
        if (!byId.has(normalized)) {
          throw new Error(`Unknown Company checklist item ${normalized}`);
        }
        return {
          id: normalized,
          text: item.text,
          checked: item.checked,
          position: index,
        };
      }
      return {
        id: randomUUID(),
        text: item.text,
        checked: item.checked,
        position: index,
      };
    });
    const updated = this.kanban.replaceKanbanCardSync(cardId, (_card, data) => ({
      ...data,
      checklist: next,
    }))!;
    return updated.checklist;
  }

  addKanbanDependencySync(
    cardId: string,
    dependsOnId: string,
  ): KanbanCardDependency {
    const normalizedCardId = assertUuid(cardId, 'Company kanban card id');
    const normalizedDependsOnId = assertUuid(
      dependsOnId,
      'Company kanban dependency target id',
    );
    if (normalizedCardId === normalizedDependsOnId) {
      throw new Error('A Company kanban card cannot depend on itself');
    }
    if (!this.kanban.getKanbanCardFullSync(normalizedDependsOnId)) {
      throw new Error(`Unknown dependency target ${normalizedDependsOnId}`);
    }
    const current = this.kanban.getKanbanCardFullSync(normalizedCardId);
    if (!current) throw new Error(`Unknown Company kanban card ${normalizedCardId}`);
    const existing = current.dependencies.find(
      (dependency) => dependency.depends_on_id === normalizedDependsOnId,
    );
    if (existing) return existing;
    const cards = this.kanban.listKanbanCardsFullSync();
    const byId = new Map(cards.map((card) => [card.id, card]));
    const pending = [normalizedDependsOnId];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const candidateId = pending.pop()!;
      if (candidateId === normalizedCardId) {
        throw new Error(
          `Company kanban dependency ${normalizedCardId} -> ${normalizedDependsOnId} creates a cycle`,
        );
      }
      if (visited.has(candidateId)) continue;
      visited.add(candidateId);
      const candidate = byId.get(candidateId);
      if (!candidate) {
        throw new Error(
          `Company kanban dependency graph references missing card ${candidateId}`,
        );
      }
      for (const dependency of candidate.dependencies) {
        pending.push(dependency.depends_on_id);
      }
    }
    const dependency = {
      id: randomUUID(),
      depends_on_id: normalizedDependsOnId,
      created_at: new Date().toISOString(),
    };
    const updated = this.kanban.replaceKanbanCardSync(normalizedCardId, (_card, data) => ({
      ...data,
      dependencies: [
        ...(Array.isArray(data.dependencies) ? data.dependencies : []),
        dependency,
      ],
    }))!;
    return updated.dependencies.find((row) => row.id === dependency.id)!;
  }

  removeKanbanDependencySync(
    cardId: string,
    dependsOnId: string,
  ): KanbanCardDependency | null {
    const current = this.kanban.getKanbanCardFullSync(cardId);
    if (!current) return null;
    const dependency = current.dependencies.find(
      (row) => row.depends_on_id === dependsOnId,
    );
    if (!dependency) return null;
    this.kanban.replaceKanbanCardSync(cardId, (_card, data) => ({
      ...data,
      dependencies: (Array.isArray(data.dependencies) ? data.dependencies : [])
        .filter((row) => object(row).id !== dependency.id),
    }));
    return dependency;
  }

  assignKanbanAgentSync(
    cardId: string,
    agentRunId: string,
    role: string,
  ): KanbanCardAgent {
    const normalizedAgentRunId = asAgentRunId(agentRunId);
    // Kanban belongs to the root bundle, while a dispatched subordinate may
    // belong to a child bundle. Keep the UUID as an explicit cross-bundle
    // relation; the spawning workflow validates that run before assignment.
    const assignment = {
      id: randomUUID(),
      agent_run_id: normalizedAgentRunId,
      role,
      assigned_at: new Date().toISOString(),
      unassigned_at: null,
    };
    const updated = this.kanban.replaceKanbanCardSync(cardId, (_card, data) => ({
      ...data,
      agents: [...(Array.isArray(data.agents) ? data.agents : []), assignment],
    }));
    if (!updated) throw new Error(`Unknown Company kanban card ${cardId}`);
    return updated.agents.find((row) => row.id === assignment.id)!;
  }

  unassignKanbanAgentSync(
    cardId: string,
    agentRunId: string,
  ): KanbanCardAgent | null {
    const current = this.kanban.getKanbanCardFullSync(cardId);
    if (!current) return null;
    const assignment = [...current.agents].reverse().find(
      (row) => row.agent_run_id === agentRunId && row.unassigned_at == null,
    );
    if (!assignment) return null;
    const now = new Date().toISOString();
    const updated = this.kanban.replaceKanbanCardSync(cardId, (_card, data) => ({
      ...data,
      agents: (Array.isArray(data.agents) ? data.agents : []).map((row) => {
        const value = object(row);
        return value.id === assignment.id
          ? { ...value, unassigned_at: now }
          : value;
      }),
    }))!;
    return updated.agents.find((row) => row.id === assignment.id) ?? null;
  }
}
