/**
 * BoardBridge — the per-session board (persisted message log). Handles:
 *   - Writing entries with auto-extracted @mentions
 *   - Advancing the master watermark (so notifications include only new entries)
 *   - Publishing `board_entry` events to the meta-bus
 *   - Auto-hook: subordinate "deliverable" posts move the card to review
 *
 * The auto-hook is the one place where BoardBridge knows about Kanban; we
 * inject `IKanbanNotifier` so the dependency is narrow and testable.
 *
 * Multi-front (migration 067) is achieved by having the orchestrator
 * scope itself to a single CompanySession — sub-sessions are siblings
 * via `parent_session_id`, and the board is naturally isolated by the
 * `company_session_id` FK. No per-front bookkeeping needed here.
 */

import type { SessionContext } from './SessionContext.js';
import type {
  BoardKind,
  IBoardPoster,
  IKanbanNotifier,
  IMetaBusPublisher,
} from './ports.js';
import type { BoardEntry } from '../types.js';

export class BoardBridge implements IBoardPoster {
  private watermark = 0;

  constructor(
    private readonly ctx: SessionContext,
    private readonly bus: IMetaBusPublisher,
    private readonly kanban: IKanbanNotifier,
  ) {}

  get lastMasterSeenId(): number {
    return this.watermark;
  }

  advanceMasterWatermark(entryId: number): void {
    this.watermark = Math.max(this.watermark, entryId);
  }

  post(
    authorRole: string,
    agentRunId: number | null,
    kind: BoardKind,
    content: string,
    mentions?: string[],
  ): void {
    const extractedMentions = mentions ?? [];
    if (!mentions) {
      const re = /@(\w+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content))) extractedMentions.push(m[1]);
    }

    const entry = this.ctx.companyStore.postToBoard(
      this.ctx.companySessionId,
      authorRole,
      agentRunId,
      kind,
      content,
      extractedMentions,
    );

    // Master "sees" its own posts and system announcements — advance watermark
    // so notifyMasterAboutSubordinate doesn't replay them.
    if (authorRole === 'master' || authorRole === 'system') {
      this.advanceMasterWatermark(entry.id);
    }

    this.bus.publish('board_entry', {
      id: entry.id,
      author_role: entry.author_role,
      agent_run_id: entry.agent_run_id,
      kind: entry.kind,
      content: entry.content,
      mentions: entry.mentions,
      created_at: entry.created_at,
    });

    // Kanban auto-hook: a subordinate's deliverable auto-advances the card
    // to "review" so the master can verify without an explicit move call.
    if (
      kind === 'deliverable' &&
      agentRunId != null &&
      authorRole !== 'system' &&
      authorRole !== 'master'
    ) {
      try {
        const cardId = this.kanban.findCardForAgent(agentRunId);
        if (cardId) {
          const card = this.kanban.getCard(cardId);
          if (card && card.column === 'in_progress') {
            this.kanban.moveCard(cardId, 'review');
            this.kanban.addComment(
              cardId,
              authorRole,
              agentRunId,
              `[AUTO] Deliverable posted to board. Card moved to review.`,
            );
          }
        }
      } catch {
        // Best-effort — never let kanban failures break the board post.
      }
    }
  }

  read(opts?: { sinceId?: number; limit?: number; mentionsRole?: string }): BoardEntry[] {
    const entries = this.ctx.companyStore.readBoard(this.ctx.companySessionId, {
      sinceId: opts?.sinceId,
      limit: opts?.limit ?? 50,
    });
    if (opts?.mentionsRole) {
      return entries.filter(
        (e) => e.mentions.includes(opts.mentionsRole!) || e.mentions.includes('all'),
      );
    }
    return entries;
  }
}
