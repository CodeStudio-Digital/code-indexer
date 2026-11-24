
import type { TaskEvidence } from '@mcp/company-contracts/models/kanban.js';
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
    items: Array<{ id?: string; text: string; checked: boolean }> | undefined,
    evidence?: TaskEvidence,
    agentRunId?: string | null,
  ): KanbanChecklistItem[] {
    const updated = this.kanban.replaceKanbanCardSync(cardId, (card, data) => {
      const changes: Record<string, unknown> = {};
      if (items) {
        const existing = new Set(card.checklist.map(item => item.id));
        changes.checklist = items.map((item, position) => {
          const id = item.id ? assertUuid(item.id, 'Company checklist item id') : randomUUID();
          if (item.id && !existing.has(id)) throw new Error(`Unknown Company checklist item ${id}`);
          return { id, text: item.text, checked: item.checked, position };
        });
      }
      if (evidence?.length) {
        if (!card.control || card.column === 'done') throw new Error('Reabra o cartão e confira seus critérios de aceite.');
        if (agentRunId && !card.agents.some(a => a.agent_run_id === agentRunId && !a.unassigned_at)) {
          throw new Error('O agente precisa estar atribuído a esta tarefa para registrar evidências.');
        }
        const acceptance = [...card.control.acceptance];
        const recorded = new Set<number>();
        for (const entry of evidence) {
          if (acceptance[entry.index]?.criterion !== entry.criterion || recorded.has(entry.index)) {
            throw new Error('O critério mudou ou foi informado duas vezes. Consulte o cartão.');
          }
          recorded.add(entry.index);
          acceptance[entry.index] = { criterion: entry.criterion, evidence: entry.evidence };
        }
        changes.control = { ...card.control, acceptance };
      }
      return { ...data, ...changes };
    });
    if (!updated) throw new Error(`Unknown Company kanban card ${cardId}`);
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
    sessionId?: string,
  ): KanbanCardAgent {
    const normalizedAgentRunId = asAgentRunId(agentRunId);
    // Kanban belongs to the root bundle, while a dispatched subordinate may
    // belong to a child bundle. Keep the UUID as an explicit cross-bundle
    // relation; the spawning workflow validates that run before assignment.
    const card = this.kanban.getKanbanCardFullSync(cardId);
    if (!card) throw new Error(`Unknown Company kanban card ${cardId}`);
    if (card.control?.owner && card.control.owner !== role) {
      throw new Error(`Card belongs to @${card.control.owner}, requested @${role}`);
    }
    const current = card.agents.find(a => !a.unassigned_at);
    if (current) {
      if (current.agent_run_id === normalizedAgentRunId && current.role === role) return current;
      throw new Error(`Card already assigned to @${current.role} (run=${current.agent_run_id})`);
    }
    const assignment = {
      id: randomUUID(),
      agent_run_id: normalizedAgentRunId,
      ...(sessionId && {session_id:sessionId}),
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
