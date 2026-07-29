/**
 * v4.5 — server-side bridge between QA test outcomes and the Kanban board.
 *
 * Today's pain (matches user's complaint #4):
 *   - The Master prompt INSTRUCTS the QA agent to manually file bug cards
 *     via `kanban_create_card`. In practice subordinates skip the step,
 *     duplicate the card across reruns, or never link it to the feature
 *     card. Operators end up babysitting the board.
 *   - QA-result and Kanban-card entities are related by UUID, so the
 *     dashboard can't deep-link from a failure row to "the bug card".
 *
 * What this bridge does on every `qa_run_completed`:
 *   1. For each failing/timed-out/interrupted result, upsert a Kanban
 *      card with `tag='bug'` and stamp the card id back on the result
 *      result entity (`kanban_card_id`). Idempotent across reruns:
 *      we look up the most recent result for the same
 *      `(spec_file, test_name)` and reuse its `kanban_card_id` if the
 *      card still exists, appending a "failure recurred" comment
 *      instead of minting a duplicate.
 *   2. When the QA-run entity's `kanban_feature_card_id` is set, transition the
 *      feature card based on the run's verdict:
 *        - all green → move to `done`, comment "QA verde — run #<id>".
 *        - any red    → move to `in_progress` (if not already there or
 *                       past it) and comment "QA red — see run #<id>".
 *
 * The bridge depends ONLY on the filesystem-backed Kanban adapter +
 * QaTestResultStore, so it can run from `test-event.ts` even when the
 * per-session orchestrator has been evicted (the QA agent finished the
 * suite but the operator already navigated away).
 *
 * Pure-ish: every function takes its dependencies as arguments. Errors
 * are caught and surfaced via the return value — never thrown. Losing
 * a kanban link is a soft failure; the run completion must always
 * succeed.
 */
import type {
  KanbanCard,
  KanbanComment,
  KanbanCardDependency,
} from '@mcp/company/types.js';
import type { IQaTestResultStore } from './store/interfaces.js';
import type { QaRun, QaTestResult } from './types.js';

type Awaitable<T> = T | Promise<T>;

export interface QaKanbanStore {
  createKanbanCard(
    sessionId: string,
    input: {
      title: string;
      description?: string;
      column?: 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';
      tag?: 'bug' | 'feature' | 'refactor' | 'documentation' | null;
      created_by?: string;
    },
  ): Awaitable<KanbanCard>;
  getKanbanCard(cardId: string): Awaitable<KanbanCard | null>;
  addKanbanComment(
    cardId: string,
    authorRole: string,
    agentRunId: string | null,
    content: string,
  ): Awaitable<KanbanComment>;
  addCardDependency(
    cardId: string,
    dependsOnId: string,
  ): Awaitable<KanbanCardDependency>;
  moveKanbanCard(
    cardId: string,
    toColumn: 'backlog' | 'todo' | 'in_progress' | 'review' | 'done',
  ): Awaitable<KanbanCard>;
}

export interface KanbanBridgeDeps {
  companyStore: QaKanbanStore;
  qaResultStore: Pick<IQaTestResultStore, 'findRecentResultByName' | 'setKanbanCardId'>;
}

/**
 * URL builder for evidence shown on the bug card. Injected so unit
 * tests don't need to mirror the route layout — also lets a future
 * frontend deep-link change without modifying the bridge.
 */
export type EvidenceUrlBuilder = (relPath: string) => string;

export interface UpsertBugCardOpts {
  sessionId: string;
  run: QaRun;
  result: QaTestResult;
  buildEvidenceUrl: EvidenceUrlBuilder;
  /** Optional dashboard run-detail URL appended to comments + descriptions. */
  runDetailUrl?: string;
}

export interface UpsertBugCardOutcome {
  cardId: string | null;
  /** True when this call created the card; false when it reused. */
  created: boolean;
  warnings: string[];
}

/**
 * Idempotent: insert OR update the bug card for a `(suite, test)` pair.
 * Stamps the QA-result entity's `kanban_card_id` on success.
 */
export async function upsertBugCard(
  deps: KanbanBridgeDeps,
  opts: UpsertBugCardOpts,
): Promise<UpsertBugCardOutcome> {
  const out: UpsertBugCardOutcome = { cardId: null, created: false, warnings: [] };

  // 1) Idempotency lookup — the same test failing in a prior run already
  //    has an open card; reuse it instead of duplicating.
  let reuseCardId: string | null = null;
  try {
    const prior = await deps.qaResultStore.findRecentResultByName({
      spec_file: opts.result.spec_file,
      test_name: opts.result.test_name,
    });
    if (prior?.kanban_card_id) {
      const existing = await deps.companyStore.getKanbanCard(prior.kanban_card_id);
      if (existing) reuseCardId = existing.id;
    }
  } catch (e) {
    out.warnings.push(`bridge lookup failed: ${errMsg(e)}`);
  }

  if (reuseCardId !== null) {
    try {
      await deps.companyStore.addKanbanComment(
        reuseCardId,
        'qa-bridge',
        null,
        renderRecurrenceComment(opts),
      );
    } catch (e) {
      out.warnings.push(`addKanbanComment failed: ${errMsg(e)}`);
    }
    try {
      await deps.qaResultStore.setKanbanCardId(opts.result.id, reuseCardId);
    } catch (e) {
      out.warnings.push(`setKanbanCardId failed: ${errMsg(e)}`);
    }
    out.cardId = reuseCardId;
    return out;
  }

  // 2) Mint a fresh card.
  let cardId: string | null = null;
  try {
    const card = await deps.companyStore.createKanbanCard(opts.sessionId, {
      title: renderBugTitle(opts),
      description: renderBugDescription(opts),
      column: 'todo',
      tag: 'bug',
      created_by: 'qa-bridge',
    });
    cardId = card.id;
    out.created = true;
  } catch (e) {
    out.warnings.push(`createKanbanCard failed: ${errMsg(e)}`);
    return out;
  }

  // 3) Optional dependency edge — link the bug to the feature card it
  //    audits. Best-effort: a missing feature-card reference doesn't
  //    block the bridge.
  if (opts.run.kanban_feature_card_id != null) {
    try {
      await deps.companyStore.addCardDependency(cardId, opts.run.kanban_feature_card_id);
    } catch (e) {
      out.warnings.push(`addCardDependency failed: ${errMsg(e)}`);
    }
  }

  // 4) Stamp the FK on the result row.
  try {
    await deps.qaResultStore.setKanbanCardId(opts.result.id, cardId);
  } catch (e) {
    out.warnings.push(`setKanbanCardId failed: ${errMsg(e)}`);
  }

  out.cardId = cardId;
  return out;
}

export interface SyncFeatureCardOpts {
  featureCardId: string;
  run: QaRun;
  /** Already aggregated by the test-event handler before calling. */
  passed: number;
  failed: number;
  /** Optional dashboard run-detail URL surfaced in the comment. */
  runDetailUrl?: string;
}

export interface SyncFeatureCardOutcome {
  /** Column the card is at after the sync (current value when no move occurred). */
  column: string | null;
  warnings: string[];
}

/**
 * Move the feature card based on the run's outcome. Skip when the card
 * is missing or already in the target column. Side-effect: appends a
 * comment so the operator sees the QA verdict in context.
 */
export async function syncFeatureCard(
  deps: KanbanBridgeDeps,
  opts: SyncFeatureCardOpts,
): Promise<SyncFeatureCardOutcome> {
  const out: SyncFeatureCardOutcome = { column: null, warnings: [] };

  const card = await deps.companyStore.getKanbanCard(opts.featureCardId);
  if (!card) {
    out.warnings.push(`feature card ${opts.featureCardId} missing — skipping sync`);
    return out;
  }
  out.column = card.column;

  const allGreen = opts.failed === 0 && opts.passed > 0;
  const anyRed = opts.failed > 0;

  // Don't move done cards back; let the operator decide.
  if (allGreen && card.column !== 'done') {
    try {
      const moved = await deps.companyStore.moveKanbanCard(opts.featureCardId, 'done');
      out.column = moved.column;
    } catch (e) {
      out.warnings.push(`moveKanbanCard(done) failed: ${errMsg(e)}`);
    }
    try {
      await deps.companyStore.addKanbanComment(
        opts.featureCardId,
        'qa-bridge',
        null,
        renderGreenComment(opts),
      );
    } catch (e) {
      out.warnings.push(`addKanbanComment(green) failed: ${errMsg(e)}`);
    }
  } else if (anyRed) {
    // If the card is in `done`, demote back to `in_progress` so the
    // operator sees QA red without having to dig the history.
    if (card.column !== 'in_progress') {
      try {
        const moved = await deps.companyStore.moveKanbanCard(opts.featureCardId, 'in_progress');
        out.column = moved.column;
      } catch (e) {
        out.warnings.push(`moveKanbanCard(in_progress) failed: ${errMsg(e)}`);
      }
    }
    try {
      await deps.companyStore.addKanbanComment(
        opts.featureCardId,
        'qa-bridge',
        null,
        renderRedComment(opts),
      );
    } catch (e) {
      out.warnings.push(`addKanbanComment(red) failed: ${errMsg(e)}`);
    }
  }

  return out;
}

// ─── Pure renderers (exported for tests) ────────────────────────

export function renderBugTitle(opts: UpsertBugCardOpts): string {
  const t = opts.result.test_name.trim();
  return `[QA-BUG] ${opts.run.suite}: ${t || '(unnamed test)'}`;
}

export function renderBugDescription(opts: UpsertBugCardOpts): string {
  const lines: string[] = [];
  lines.push(`**Suite**: \`${opts.run.suite}\``);
  lines.push(`**Spec**: \`${opts.result.spec_file}\``);
  lines.push(`**Test**: \`${opts.result.test_name}\``);
  lines.push(`**Status**: ${opts.result.status}`);
  if (typeof opts.result.duration_ms === 'number') {
    lines.push(`**Duration**: ${opts.result.duration_ms} ms`);
  }
  lines.push(`**First seen**: run #${opts.run.id} (${opts.run.started_at})`);
  if (opts.runDetailUrl) {
    lines.push(`**Run detail**: ${opts.runDetailUrl}`);
  }
  if (opts.result.error) {
    lines.push('');
    lines.push('**Error**');
    lines.push('```');
    lines.push(opts.result.error);
    lines.push('```');
  }
  const evidence: string[] = [];
  if (opts.result.video_path) {
    evidence.push(`- Video: ${opts.buildEvidenceUrl(opts.result.video_path)}`);
  }
  if (opts.result.screenshot_path) {
    evidence.push(`- Screenshot: ${opts.buildEvidenceUrl(opts.result.screenshot_path)}`);
  }
  if (opts.result.trace_path) {
    evidence.push(`- Trace: ${opts.buildEvidenceUrl(opts.result.trace_path)}`);
  }
  if (opts.result.summary_md_path) {
    evidence.push(`- Summary: ${opts.buildEvidenceUrl(opts.result.summary_md_path)}`);
  }
  if (evidence.length > 0) {
    lines.push('');
    lines.push('**Evidence**');
    lines.push(...evidence);
  }
  lines.push('');
  lines.push(
    '_This card was opened automatically by the QA bridge. Recurring failures of the same test will append a comment here instead of opening a new card._',
  );
  return lines.join('\n');
}

export function renderRecurrenceComment(opts: UpsertBugCardOpts): string {
  const parts: string[] = [];
  parts.push(`Failure recurred in run #${opts.run.id} (${opts.run.started_at}).`);
  if (opts.result.error) {
    parts.push(`Error: \`${opts.result.error.split('\n')[0].slice(0, 200)}\``);
  }
  if (opts.runDetailUrl) parts.push(`Run detail: ${opts.runDetailUrl}`);
  return parts.join(' ');
}

function renderGreenComment(opts: SyncFeatureCardOpts): string {
  const url = opts.runDetailUrl ? ` (${opts.runDetailUrl})` : '';
  return `QA verde — run #${opts.run.id} passed ${opts.passed} test(s)${url}.`;
}

function renderRedComment(opts: SyncFeatureCardOpts): string {
  const url = opts.runDetailUrl ? ` (${opts.runDetailUrl})` : '';
  return `QA red — run #${opts.run.id} reports ${opts.failed} failed / ${opts.passed} passed${url}.`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
