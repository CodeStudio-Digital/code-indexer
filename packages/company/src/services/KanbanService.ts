/**
 * KanbanService — CRUD over kanban_cards with automatic meta-bus event
 * publishing. The orchestrator exposes these through thin wrappers
 * (kanbanCreateCard, kanbanMoveCard, …) so tools and HTTP routes don't
 * need to know about the service layer.
 */

import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { IMetaBusPublisher, IKanbanNotifier } from '@mcp/company/services/ports.js';
import type {
  KanbanCard,
  KanbanCardFull,
  KanbanCardAgent,
  KanbanCardDependency,
  KanbanChecklistItem,
  KanbanColumn,
  KanbanComment,
  KanbanTag,
} from '@mcp/company/types.js';
export class KanbanService implements IKanbanNotifier {
  constructor(
    private readonly ctx: SessionContext,
    private readonly bus: IMetaBusPublisher,
  ) {}

  createCard(input: {
    title: string;
    description?: string;
    column?: KanbanColumn;
    tag?: KanbanTag | null;
    created_by?: string;
    checklist?: string[];
  }): KanbanCardFull {
    const card = this.ctx.companyStore.createKanbanCard(this.ctx.effectiveSessionId, input);
    if (input.checklist) {
      for (let i = 0; i < input.checklist.length; i++) {
        this.ctx.companyStore.addChecklistItem(card.id, input.checklist[i], i);
      }
    }
    const full = this.ctx.companyStore.getKanbanCardFull(card.id)!;
    this.bus.publish('kanban_card_created', full);
    return full;
  }

  /**
   * Dependency gate. A card must not ADVANCE into an active column
   * (`in_progress`/`review`/`done`) while any card it `depends_on` is still
   * unfinished. `blocked_by` is pre-computed by the store as exactly the
   * subset of dependencies whose column !== 'done', so a non-empty list
   * means "open blockers".
   *
   * This lives at the service layer — the single chokepoint every move
   * flows through — so automation (spawn auto-move, pipeline fan-out, the
   * autonomous scheduler, HTTP routes) honors dependencies too. Previously
   * only the agent-facing `kanban_move_card` batch tool checked, leaving
   * `kanban_add_dependency` a phantom contract for every programmatic path.
   *
   * Returns the blockers when the move should be refused; a redirect (snap
   * back to the card's current column) keeps moveCard non-throwing for the
   * many best-effort callers. Reorders within the same column are allowed.
   * Never throws.
   */
  private evaluateDependencyGate(
    cardId: number,
    targetColumn: KanbanColumn,
    fromColumn: KanbanColumn | undefined,
  ): { blocked: false } | { blocked: true; blockers: Array<{ id: number; title: string; column: string }> } {
    const ACTIVE: KanbanColumn[] = ['in_progress', 'review', 'done'];
    if (!ACTIVE.includes(targetColumn)) return { blocked: false };
    if (fromColumn === targetColumn) return { blocked: false }; // reorder, not an advance
    try {
      const full = this.ctx.companyStore.getKanbanCardFull(cardId);
      if (!full || full.blocked_by.length === 0) return { blocked: false };
      const blockers = full.blocked_by.map((id) => {
        const c = this.ctx.companyStore.getKanbanCard(id);
        return { id, title: c?.title ?? '?', column: c?.column ?? 'unknown' };
      });
      return { blocked: true, blockers };
    } catch {
      return { blocked: false };
    }
  }

  /** Markdown comment explaining a dependency-gate redirect. */
  private buildDependencyComment(
    targetColumn: KanbanColumn,
    blockers: ReadonlyArray<{ id: number; title: string; column: string }>,
  ): string {
    const lines: string[] = [
      `Move to \`${targetColumn}\` refused by the dependency gate — open blockers must reach \`done\` first.`,
      '',
      'Blocking cards:',
    ];
    for (const b of blockers) {
      lines.push(`- #${b.id} "${b.title}" — currently in \`${b.column}\``);
    }
    lines.push('');
    lines.push('Move the blockers to `done`, or remove the dependency (`kanban_remove_dependency`), then retry.');
    return lines.join('\n');
  }

  moveCard(cardId: number, column: KanbanColumn, position?: number): KanbanCard {
    const before = this.ctx.companyStore.getKanbanCard(cardId);

    // A blocked card isn't advancing: snap back to the current column and
    // explain why.
    const depBlock = this.evaluateDependencyGate(cardId, column, before?.column);
    if (depBlock.blocked) {
      const stayColumn = before?.column ?? 'todo';
      const card = this.ctx.companyStore.moveKanbanCard(cardId, stayColumn, position);
      this.bus.publish('kanban_card_moved', {
        cardId,
        fromColumn: before?.column,
        toColumn: stayColumn,
        position: card.position,
        requestedColumn: column,
        dependencyBlocked: true,
        blockingCardIds: depBlock.blockers.map((b) => b.id),
      });
      try {
        const comment = this.ctx.companyStore.addKanbanComment(
          cardId,
          'dependency-gate',
          null,
          this.buildDependencyComment(column, depBlock.blockers),
        );
        this.bus.publish('kanban_comment_added', { cardId, comment });
      } catch {
        /* swallow — already snapped back, comment is best-effort */
      }
      return card;
    }

    const card = this.ctx.companyStore.moveKanbanCard(cardId, column, position);
    this.bus.publish('kanban_card_moved', {
      cardId,
      fromColumn: before?.column,
      toColumn: column,
      position: card.position,
    });
    return card;
  }

  updateCard(
    cardId: number,
    patch: { title?: string; description?: string; tag?: KanbanTag | null },
  ): KanbanCard | null {
    const card = this.ctx.companyStore.updateKanbanCard(cardId, patch);
    if (card) this.bus.publish('kanban_card_updated', { cardId, patch });
    return card;
  }

  deleteCard(cardId: number): boolean {
    const ok = this.ctx.companyStore.deleteKanbanCard(cardId);
    if (ok) this.bus.publish('kanban_card_deleted', { cardId });
    return ok;
  }

  addComment(
    cardId: number,
    authorRole: string,
    agentRunId: number | null,
    content: string,
  ): KanbanComment {
    const comment = this.ctx.companyStore.addKanbanComment(cardId, authorRole, agentRunId, content);
    this.bus.publish('kanban_comment_added', { cardId, comment });
    return comment;
  }

  updateChecklist(
    cardId: number,
    items: Array<{ id?: number; text: string; checked: boolean }>,
  ): KanbanChecklistItem[] {
    const result: KanbanChecklistItem[] = [];
    for (const item of items) {
      if (item.id) {
        const updated = this.ctx.companyStore.updateChecklistItem(item.id, {
          text: item.text,
          checked: item.checked,
        });
        if (updated) result.push(updated);
      } else {
        result.push(this.ctx.companyStore.addChecklistItem(cardId, item.text));
        if (item.checked) {
          const last = result[result.length - 1];
          this.ctx.companyStore.updateChecklistItem(last.id, { checked: true });
          last.checked = true;
        }
      }
    }
    this.bus.publish('kanban_checklist_updated', { cardId, items: result });
    return result;
  }

  addDependency(cardId: number, dependsOnId: number): KanbanCardDependency {
    const dep = this.ctx.companyStore.addCardDependency(cardId, dependsOnId);
    this.bus.publish('kanban_dependency_added', { cardId, dependsOnId });
    return dep;
  }

  removeDependency(cardId: number, dependsOnId: number): boolean {
    const ok = this.ctx.companyStore.removeCardDependency(cardId, dependsOnId);
    if (ok) this.bus.publish('kanban_dependency_removed', { cardId, dependsOnId });
    return ok;
  }

  assignAgent(cardId: number, agentRunId: number, role: string): KanbanCardAgent {
    const assignment = this.ctx.companyStore.assignAgentToCard(cardId, agentRunId, role);
    this.bus.publish('kanban_agent_assigned', { cardId, agentRunId, role });
    return assignment;
  }

  unassignAgent(cardId: number, agentRunId: number): void {
    this.ctx.companyStore.unassignAgentFromCard(cardId, agentRunId);
    this.bus.publish('kanban_agent_unassigned', { cardId, agentRunId });
  }

  listCards(opts?: { column?: KanbanColumn }): KanbanCard[] {
    return this.ctx.companyStore.listKanbanCards(this.ctx.effectiveSessionId, opts);
  }

  getCard(cardId: number): KanbanCardFull | null {
    return this.ctx.companyStore.getKanbanCardFull(cardId);
  }

  listCardsFull(): KanbanCardFull[] {
    return this.ctx.companyStore.listKanbanCardsFull(this.ctx.effectiveSessionId);
  }

  /** Find the kanban card currently assigned to the given agent run. */
  findCardForAgent(agentRunId: number): number | null {
    const cards = this.ctx.companyStore.listKanbanCardsFull(this.ctx.effectiveSessionId);
    const myCard = cards.find(
      (c) => c.agents.some((a) => a.agent_run_id === agentRunId && !a.unassigned_at),
    );
    return myCard?.id ?? null;
  }

  /** Build a markdown context block describing the card for subordinate injection. */
  getCardContextForSubordinate(cardId: number): string {
    const card = this.ctx.companyStore.getKanbanCardFull(cardId);
    if (!card) return '';
    const lines: string[] = [];
    lines.push(`# Kanban Card: ${card.title}`);
    if (card.tag) lines.push(`Tag: ${card.tag}`);
    if (card.description) lines.push(`\n## Description\n${card.description}`);
    if (card.checklist.length > 0) {
      lines.push('\n## Objectives');
      for (const item of card.checklist) {
        lines.push(`- [${item.checked ? 'x' : ' '}] ${item.text}`);
      }
    }
    if (card.dependencies.length > 0) {
      lines.push('\n## Dependencies');
      for (const dep of card.dependencies) {
        const depCard = this.ctx.companyStore.getKanbanCard(dep.depends_on_id);
        const status = depCard
          ? (depCard.column === 'done' ? 'DONE' : `IN ${depCard.column.toUpperCase()}`)
          : 'unknown';
        lines.push(`- Blocked by card #${dep.depends_on_id} (${depCard?.title ?? '?'}) — ${status}`);
      }
    }
    if (card.agents.length > 0) {
      lines.push('\n## Agent History');
      for (const a of card.agents) {
        const status = a.unassigned_at ? `unassigned at ${a.unassigned_at}` : 'currently assigned';
        lines.push(`- ${a.role} (run #${a.agent_run_id}) — ${status}`);
      }
    }
    if (card.comments.length > 0) {
      lines.push('\n## Context Log');
      for (const c of card.comments) {
        lines.push(`\n### ${c.author_role} (${c.created_at})`);
        lines.push(c.content);
      }
    }
    return lines.join('\n');
  }
}
