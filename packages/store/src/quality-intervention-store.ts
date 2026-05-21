/**
 * QualityInterventionStore — CRUD + effectiveness aggregation over the
 * `quality_interventions` table (migration 090).
 *
 * This table records every signal the quality pipeline injects into the
 * agent's loop (system-prompt nudge, planning intervention, policy block,
 * board alert). The point is to know — empirically, with numbers — whether
 * those signals make the next turn BETTER, the same, or worse.
 *
 * The store is split into three concerns:
 *
 *   1. `insert(row)` — called when an intervention is emitted. Records
 *      WHY (triggering verdicts) and WHEN. `outcome` starts as 'pending'.
 *
 *   2. `recordOutcome(id, nextVerdicts, computedOutcome)` — called when
 *      the FOLLOWING classified turn lands. Backfills `next_turn_verdicts_json`
 *      and `outcome`. Outcome computation lives in `feedback-builder.ts`
 *      (`computeOutcome`) — this store is dumb about it on purpose.
 *
 *   3. `effectivenessStats({ since })` — aggregate "what fraction of nudges
 *      improved the next turn?" — drives the QualityPanel dashboard section.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export type InterventionType =
  | 'nudge'
  | 'planning'
  | 'policy_block'
  | 'board_alert'
  | 'nudge_suppressed';

export type InterventionOutcomeRow = 'improved' | 'unchanged' | 'worsened' | 'pending';

/**
 * Snapshot of a single verdict for the JSON columns. Mirrors the shape
 * of `ClassificationVerdict` in @mcp/services/quality but kept here as a
 * structural type to avoid a cross-package import that the store
 * doesn't otherwise need.
 */
export interface InterventionVerdictSnapshot {
  classifierName: string;
  verdict: 'ok' | 'warn' | 'flagged' | 'error';
  confidence?: number | null;
  reason?: string | null;
}

export interface QualityInterventionRow {
  id: number;
  session_id: number | null;
  company_session_id: number | null;
  agent_run_id: number | null;
  turn_fired: number;
  intervention_type: InterventionType;
  triggering_verdicts_json: string;
  triggering_classifiers: string;
  next_turn_verdicts_json: string | null;
  outcome: InterventionOutcomeRow | null;
  outcome_recorded_at: string | null;
  nudge_chars: number | null;
  created_at: string;
}

export interface QualityInterventionInsert {
  session_id?: number | null;
  company_session_id?: number | null;
  agent_run_id?: number | null;
  turn_fired: number;
  intervention_type: InterventionType;
  triggering_verdicts: ReadonlyArray<InterventionVerdictSnapshot>;
  nudge_chars?: number | null;
}

export interface EffectivenessStats {
  /** Counts per intervention_type × outcome. */
  byType: Array<{
    intervention_type: InterventionType;
    improved: number;
    unchanged: number;
    worsened: number;
    pending: number;
    /** Sum of the three non-pending buckets. */
    measured: number;
    /** `improved / measured` (0 if measured == 0). Used for the dashboard headline. */
    improved_rate: number;
  }>;
  /** Recent interventions (newest first, capped). For the "recent activity" list. */
  recent: Array<Pick<
    QualityInterventionRow,
    | 'id'
    | 'session_id'
    | 'agent_run_id'
    | 'turn_fired'
    | 'intervention_type'
    | 'outcome'
    | 'triggering_classifiers'
    | 'created_at'
  >>;
}

export class QualityInterventionStore {
  constructor(private db: DB) {}

  /**
   * Insert a fresh intervention row with `outcome='pending'`. The caller
   * stores the returned id so the backfill path can update the same row
   * when the next classifier turn completes.
   */
  insert(input: QualityInterventionInsert): number {
    const classifiers = input.triggering_verdicts
      .map((v) => v.classifierName)
      .filter((v, i, arr) => arr.indexOf(v) === i) // dedupe
      .join(',');
    const result = this.db
      .prepare(
        `INSERT INTO quality_interventions (
           session_id, company_session_id, agent_run_id, turn_fired,
           intervention_type, triggering_verdicts_json, triggering_classifiers,
           outcome, nudge_chars
         ) VALUES (
           @session_id, @company_session_id, @agent_run_id, @turn_fired,
           @intervention_type, @triggering_verdicts_json, @triggering_classifiers,
           'pending', @nudge_chars
         )`,
      )
      .run({
        session_id: input.session_id ?? null,
        company_session_id: input.company_session_id ?? null,
        agent_run_id: input.agent_run_id ?? null,
        turn_fired: input.turn_fired,
        intervention_type: input.intervention_type,
        triggering_verdicts_json: JSON.stringify(input.triggering_verdicts),
        triggering_classifiers: classifiers,
        nudge_chars: input.nudge_chars ?? null,
      });
    return Number(result.lastInsertRowid);
  }

  /**
   * Find pending interventions for `(sessionId, turn_fired = turnBefore)`.
   * The backfill path calls this after a classifier turn completes to know
   * "which intervention(s) is this turn's verdict the outcome of?". Usually
   * 0 or 1 rows; can be 2+ when both a nudge AND a planning intervention
   * fired in the same prior turn.
   */
  findPendingByPriorTurn(sessionId: number, turnBefore: number): QualityInterventionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM quality_interventions
         WHERE session_id = @session_id
           AND turn_fired = @turn_before
           AND outcome = 'pending'`,
      )
      .all({ session_id: sessionId, turn_before: turnBefore }) as QualityInterventionRow[];
  }

  /**
   * Backfill the outcome of a previously-inserted intervention.
   *
   * The caller (global classifier runner) computes `outcome` via
   * `computeOutcome(before, after)` and passes both the result and the
   * snapshot of the "after" verdicts that justified the result. We don't
   * recompute here — keeps the store pure storage and the policy in
   * `feedback-builder.ts`.
   */
  recordOutcome(input: {
    id: number;
    next_turn_verdicts: ReadonlyArray<InterventionVerdictSnapshot>;
    outcome: 'improved' | 'unchanged' | 'worsened';
  }): boolean {
    const result = this.db
      .prepare(
        `UPDATE quality_interventions
            SET next_turn_verdicts_json = @next_turn_verdicts_json,
                outcome                  = @outcome,
                outcome_recorded_at      = datetime('now')
          WHERE id = @id
            AND outcome = 'pending'`,
      )
      .run({
        id: input.id,
        next_turn_verdicts_json: JSON.stringify(input.next_turn_verdicts),
        outcome: input.outcome,
      });
    return Number(result.changes) > 0;
  }

  /**
   * Aggregate dashboard metrics. The window default is "everything"; pass
   * `since` (ISO-ish timestamp like `'2026-05-12 00:00:00'`) to scope the
   * panel to recent activity.
   */
  effectivenessStats(opts: { since?: string; recentLimit?: number } = {}): EffectivenessStats {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts.since) { where.push('created_at >= @since'); params.since = opts.since; }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const rows = this.db
      .prepare(
        `SELECT intervention_type, outcome, COUNT(*) AS count
           FROM quality_interventions ${whereSql}
          GROUP BY intervention_type, outcome`,
      )
      .all(params) as Array<{ intervention_type: InterventionType; outcome: InterventionOutcomeRow | null; count: number }>;

    // Pivot into one row per intervention_type.
    const typeMap = new Map<
      InterventionType,
      { improved: number; unchanged: number; worsened: number; pending: number }
    >();
    for (const r of rows) {
      const type = r.intervention_type;
      const slot = typeMap.get(type) ?? { improved: 0, unchanged: 0, worsened: 0, pending: 0 };
      if (r.outcome === 'improved')   slot.improved   += r.count;
      else if (r.outcome === 'worsened')  slot.worsened += r.count;
      else if (r.outcome === 'unchanged') slot.unchanged += r.count;
      else slot.pending += r.count; // null or 'pending'
      typeMap.set(type, slot);
    }

    const byType: EffectivenessStats['byType'] = [];
    for (const [type, slot] of typeMap) {
      const measured = slot.improved + slot.unchanged + slot.worsened;
      byType.push({
        intervention_type: type,
        ...slot,
        measured,
        improved_rate: measured > 0 ? slot.improved / measured : 0,
      });
    }
    byType.sort((a, b) => a.intervention_type.localeCompare(b.intervention_type));

    const recentLimit = opts.recentLimit ?? 20;
    const recent = this.db
      .prepare(
        `SELECT id, session_id, agent_run_id, turn_fired, intervention_type,
                outcome, triggering_classifiers, created_at
           FROM quality_interventions ${whereSql}
          ORDER BY created_at DESC, id DESC
          LIMIT ${recentLimit}`,
      )
      .all(params) as EffectivenessStats['recent'];

    return { byType, recent };
  }

  /**
   * Read a single row (used by tests and ad-hoc debugging).
   */
  get(id: number): QualityInterventionRow | null {
    const row = this.db
      .prepare(`SELECT * FROM quality_interventions WHERE id = ?`)
      .get(id) as QualityInterventionRow | undefined;
    return row ?? null;
  }

  /**
   * Retention housekeeping. Default: delete rows older than 30 days.
   * Mirrors `QualityClassificationStore.pruneOlderThan`.
   */
  pruneOlderThan(cutoff: string): number {
    const result = this.db
      .prepare(`DELETE FROM quality_interventions WHERE created_at < ?`)
      .run(cutoff);
    return Number(result.changes);
  }
}
