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
import {
  QualityClassificationStore,
  type QualityClassificationRow,
} from '@mcp/store/quality-classification-store.js';

/**
 * Wire #3 — Quality gate window. Verdicts older than this don't trigger
 * the gate (the card may have been worked, then sat for hours/days while
 * humans reviewed, and stale verdicts about prior work should not block
 * a confident move). Tunable per environment.
 */
const QUALITY_GATE_WINDOW_MS = Number(
  process.env.MCP_KANBAN_QUALITY_GATE_WINDOW_MS ?? 60 * 60_000,
);

/** Minimum confidence for a verdict to count toward the gate. */
const QUALITY_GATE_MIN_CONFIDENCE = Number(
  process.env.MCP_KANBAN_QUALITY_GATE_MIN_CONFIDENCE ?? 0.7,
);

export class KanbanService implements IKanbanNotifier {
  /**
   * Lazy quality store — constructed on first access. Reuses the session
   * context's DB handle so we don't open a second connection. Kept as a
   * cached private so repeated `moveCard` calls don't re-instantiate.
   */
  private _qualityStore: QualityClassificationStore | null | undefined;

  constructor(
    private readonly ctx: SessionContext,
    private readonly bus: IMetaBusPublisher,
  ) {}

  /**
   * Wire #3 — Resolve the quality store. Returns `null` (cached) when
   * the DB doesn't have the `quality_classifications` table (migration
   * not run — tests, fresh installs, etc.). Falsy results from this
   * lookup are treated as "gate disabled" by `moveCard`.
   */
  private getQualityStore(): QualityClassificationStore | null {
    if (this._qualityStore !== undefined) return this._qualityStore;
    try {
      const raw = this.ctx.db.raw();
      // Sanity check — the table must exist. Older / freshly-bootstrapped
      // DBs may not have run the migration yet.
      const row = raw
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='quality_classifications'`)
        .get();
      if (!row) { this._qualityStore = null; return null; }
      this._qualityStore = new QualityClassificationStore(raw);
    } catch {
      this._qualityStore = null;
    }
    return this._qualityStore;
  }

  /**
   * Wire #3 — Quality gate decision.
   *
   * When a card is being moved TO `done`, look up every agent that worked
   * the card and fetch their recent verdicts. If any verdict in the window
   * is `warn` or `flagged` above the confidence floor, return the gate
   * details. The caller redirects to `review` with a comment so the
   * master sees WHY it didn't reach `done`.
   *
   * Movement FROM `review` to `done` skips the gate — the explicit
   * pass through `review` represents a human review-cycle, so a second
   * gate-block would be obnoxious.
   *
   * Never throws.
   */
  private evaluateQualityGate(
    cardId: number,
    targetColumn: KanbanColumn,
    fromColumn: KanbanColumn | undefined,
  ): { blocked: false } | { blocked: true; offendingVerdicts: QualityClassificationRow[] } {
    if (targetColumn !== 'done') return { blocked: false };
    if (fromColumn === 'review') return { blocked: false }; // explicit second pass
    const store = this.getQualityStore();
    if (!store) return { blocked: false };

    let agentRunIds: number[] = [];
    try {
      const cardFull = this.ctx.companyStore.getKanbanCardFull(cardId);
      if (!cardFull) return { blocked: false };
      agentRunIds = cardFull.agents
        .map((a) => a.agent_run_id)
        .filter((id) => Number.isFinite(id));
    } catch {
      return { blocked: false };
    }
    if (agentRunIds.length === 0) return { blocked: false };

    let rows: QualityClassificationRow[] = [];
    try {
      rows = store.findRecentByAgentRunIds(agentRunIds, {
        sinceMs: QUALITY_GATE_WINDOW_MS,
        limit: 200,
      });
    } catch {
      return { blocked: false };
    }
    const offending = rows.filter(
      (r) =>
        (r.verdict === 'warn' || r.verdict === 'flagged') &&
        (r.confidence ?? 0) >= QUALITY_GATE_MIN_CONFIDENCE,
    );
    if (offending.length === 0) return { blocked: false };
    return { blocked: true, offendingVerdicts: offending };
  }

  /**
   * Wire #3 — Build a markdown comment summarizing why the gate redirected
   * the move. Added to the card so the master sees the blocking verdicts
   * without having to open another dashboard panel.
   */
  private buildGateComment(verdicts: ReadonlyArray<QualityClassificationRow>): string {
    const lines: string[] = [
      'Move to `done` redirected to `review` by the quality gate.',
      '',
      'Recent quality verdicts on this card\'s agent(s):',
    ];
    // Dedupe by classifier_name (most recent wins — rows are DESC).
    const seen = new Set<string>();
    for (const v of verdicts) {
      if (seen.has(v.classifier_name)) continue;
      seen.add(v.classifier_name);
      const conf = v.confidence != null ? ` (${Math.round(v.confidence * 100)}%)` : '';
      const reason = v.reason ? ` — "${v.reason.replace(/\s+/g, ' ').trim().slice(0, 200)}"` : '';
      lines.push(`- \`${v.classifier_name}\` = **${v.verdict}**${conf}${reason}`);
    }
    lines.push('');
    lines.push('Review the work, address the concerns, then move from `review` to `done` (the gate skips that transition).');
    return lines.join('\n');
  }

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

    // Dependency gate runs FIRST: a blocked card isn't advancing, so the
    // quality gate (which only fires on a move TO `done`) is moot. When
    // blocked we snap back to the card's current column and explain why.
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

    // Wire #3 — Quality gate. When destination is `done` and we have
    // recent warn/flagged verdicts on this card's agents, redirect to
    // `review` and post an explanatory comment. The master is then in
    // the driver's seat: review the verdicts, address the concerns,
    // then promote review→done (the gate skips that transition).
    let effectiveColumn = column;
    let gateBlock: ReturnType<typeof this.evaluateQualityGate> = { blocked: false };
    try {
      gateBlock = this.evaluateQualityGate(cardId, column, before?.column);
    } catch {
      // Gate evaluation must never break a kanban move.
      gateBlock = { blocked: false };
    }
    if (gateBlock.blocked) {
      effectiveColumn = 'review';
    }

    const card = this.ctx.companyStore.moveKanbanCard(cardId, effectiveColumn, position);
    this.bus.publish('kanban_card_moved', {
      cardId,
      fromColumn: before?.column,
      toColumn: effectiveColumn,
      position: card.position,
      ...(gateBlock.blocked
        ? { requestedColumn: column, qualityGateBlocked: true, blockingVerdictCount: gateBlock.offendingVerdicts.length }
        : {}),
    });

    // Post the gate explanation as a comment AFTER the move so the move
    // and the explanation arrive in order on the SSE channel. Failures
    // here don't roll back the move.
    if (gateBlock.blocked) {
      try {
        const comment = this.ctx.companyStore.addKanbanComment(
          cardId,
          'quality-gate',
          null,
          this.buildGateComment(gateBlock.offendingVerdicts),
        );
        this.bus.publish('kanban_comment_added', { cardId, comment });
      } catch {
        /* swallow — already moved, comment is best-effort */
      }
    }

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
