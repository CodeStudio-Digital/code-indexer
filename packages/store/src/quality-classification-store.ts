/**
 * QualityClassificationStore — CRUD over `quality_classifications`
 * (migration 083).
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export type QualityVerdict = 'ok' | 'warn' | 'flagged' | 'error';

export interface QualityClassificationRow {
  id: number;
  session_id: number | null;
  company_session_id: number | null;
  agent_run_id: number | null;
  coder_run_id: string | null;
  parent_run_id: string | null;
  is_subagent: 0 | 1;
  subagent_profile: string | null;
  message_id: string | null;
  classifier_name: string;
  verdict: QualityVerdict;
  /**
   * 1 = infra do classifier falhou (sem binding, timeout, unparseable,
   * rate-limit) — o verdict 'error' NÃO é um julgamento do agente. 0 = o
   * verdict é julgamento real de conteúdo. Mig 202.
   */
  system_error: 0 | 1;
  confidence: number | null;
  reason: string | null;
  provider_id: string | null;
  model_id: string | null;
  latency_ms: number | null;
  cost_usd: number | null;
  raw_response_json: string | null;
  created_at: string;
}

export interface QualityClassificationInsert {
  session_id?: number | null;
  company_session_id?: number | null;
  agent_run_id?: number | null;
  coder_run_id?: string | null;
  parent_run_id?: string | null;
  is_subagent?: boolean;
  subagent_profile?: string | null;
  message_id?: string | null;
  classifier_name: string;
  verdict: QualityVerdict;
  /** True quando a falha é do SISTEMA classifier, não julgamento (mig 202). */
  system_error?: boolean;
  confidence?: number | null;
  reason?: string | null;
  provider_id?: string | null;
  model_id?: string | null;
  latency_ms?: number | null;
  cost_usd?: number | null;
  raw_response?: unknown;
}

export class QualityClassificationStore {
  constructor(private db: DB) {}

  insert(row: QualityClassificationInsert): number {
    const result = this.db
      .prepare(
        `INSERT INTO quality_classifications (
           session_id, company_session_id, agent_run_id, coder_run_id, parent_run_id,
           is_subagent, subagent_profile, message_id,
           classifier_name, verdict, system_error, confidence, reason,
           provider_id, model_id, latency_ms, cost_usd, raw_response_json
         ) VALUES (
           @session_id, @company_session_id, @agent_run_id, @coder_run_id, @parent_run_id,
           @is_subagent, @subagent_profile, @message_id,
           @classifier_name, @verdict, @system_error, @confidence, @reason,
           @provider_id, @model_id, @latency_ms, @cost_usd, @raw_response_json
         )`,
      )
      .run({
        session_id: row.session_id ?? null,
        company_session_id: row.company_session_id ?? null,
        agent_run_id: row.agent_run_id ?? null,
        coder_run_id: row.coder_run_id ?? null,
        parent_run_id: row.parent_run_id ?? null,
        is_subagent: row.is_subagent ? 1 : 0,
        subagent_profile: row.subagent_profile ?? null,
        message_id: row.message_id ?? null,
        classifier_name: row.classifier_name,
        verdict: row.verdict,
        system_error: row.system_error ? 1 : 0,
        confidence: row.confidence ?? null,
        reason: row.reason ?? null,
        provider_id: row.provider_id ?? null,
        model_id: row.model_id ?? null,
        latency_ms: row.latency_ms ?? null,
        cost_usd: row.cost_usd ?? null,
        raw_response_json: row.raw_response != null ? JSON.stringify(row.raw_response) : null,
      });
    return Number(result.lastInsertRowid);
  }

  listByAgentRun(agentRunId: number): QualityClassificationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM quality_classifications
         WHERE agent_run_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(agentRunId) as QualityClassificationRow[];
  }

  listByClassifier(classifierName: string, opts: { limit?: number; since?: string } = {}): QualityClassificationRow[] {
    const where: string[] = ['classifier_name = @classifier_name'];
    const params: Record<string, unknown> = { classifier_name: classifierName };
    if (opts.since) { where.push('created_at >= @since'); params.since = opts.since; }
    const limit = opts.limit ?? 200;
    return this.db
      .prepare(
        `SELECT * FROM quality_classifications
         WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC, id DESC
         LIMIT ${limit}`,
      )
      .all(params) as QualityClassificationRow[];
  }

  /**
   * Read recent verdicts for a coder session.
   *
   * The feedback loops (Wire #1 quality-nudge, Wire #2 tool-misuse streak)
   * call this once per turn to peek at how the previous turn(s) were judged.
   * The classifiers run fire-and-forget after the turn, so when the next
   * turn fires the row(s) MAY or MAY NOT be there yet — that's fine; an
   * empty result means "skip the nudge this turn".
   *
   * @param sessionId   coder session id (`coder_sessions.id`)
   * @param opts.limit  max rows to scan (default 30 — newest first)
   * @param opts.sinceMs only return rows newer than `now - sinceMs`
   *                    (default 5 minutes — older verdicts are stale and
   *                    likely refer to a problem the model has already moved
   *                    past)
   * @param opts.classifierName optional filter (e.g. only `tool_misuse` rows
   *                    for the streak detector)
   */
  findRecentBySession(
    sessionId: number,
    opts: { limit?: number; sinceMs?: number; classifierName?: string } = {},
  ): QualityClassificationRow[] {
    const where: string[] = ['session_id = @session_id'];
    const params: Record<string, unknown> = { session_id: sessionId };
    if (opts.classifierName) {
      where.push('classifier_name = @classifier_name');
      params.classifier_name = opts.classifierName;
    }
    if (opts.sinceMs != null && opts.sinceMs > 0) {
      const cutoff = new Date(Date.now() - opts.sinceMs).toISOString().replace('T', ' ').slice(0, 19);
      where.push('created_at >= @since');
      params.since = cutoff;
    }
    const limit = opts.limit ?? 30;
    return this.db
      .prepare(
        `SELECT * FROM quality_classifications
         WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC, id DESC
         LIMIT ${limit}`,
      )
      .all(params) as QualityClassificationRow[];
  }

  /**
   * Read verdicts for any of the given agent_run_ids.
   *
   * Wire #3 (kanban quality gate) uses this to look up all verdicts attached
   * to subordinates that worked a card — when the master tries to move the
   * card to `done`, we redirect to `review` if any verdict is `warn` or
   * `flagged` within the cutoff window.
   */
  findRecentByAgentRunIds(
    agentRunIds: ReadonlyArray<number>,
    opts: { sinceMs?: number; limit?: number } = {},
  ): QualityClassificationRow[] {
    if (agentRunIds.length === 0) return [];
    // Better-sqlite3 doesn't bind arrays — inline as parenthesized integer list
    // (each id is coerced to a finite int so injection is impossible).
    const safeIds = agentRunIds.filter((n) => Number.isFinite(n)).map((n) => Math.trunc(n));
    if (safeIds.length === 0) return [];
    const idList = safeIds.join(',');
    const where: string[] = [`agent_run_id IN (${idList})`];
    const params: Record<string, unknown> = {};
    if (opts.sinceMs != null && opts.sinceMs > 0) {
      const cutoff = new Date(Date.now() - opts.sinceMs).toISOString().replace('T', ' ').slice(0, 19);
      where.push('created_at >= @since');
      params.since = cutoff;
    }
    const limit = opts.limit ?? 200;
    return this.db
      .prepare(
        `SELECT * FROM quality_classifications
         WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC, id DESC
         LIMIT ${limit}`,
      )
      .all(params) as QualityClassificationRow[];
  }

  verdictDistribution(opts: { classifierName?: string; since?: string; excludeSystemErrors?: boolean } = {}): Array<{
    classifier_name: string;
    verdict: QualityVerdict;
    count: number;
  }> {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts.classifierName) { where.push('classifier_name = @classifierName'); params.classifierName = opts.classifierName; }
    if (opts.since) { where.push('created_at >= @since'); params.since = opts.since; }
    // Mig 202 — sem esse filtro a distribuição mistura flakiness de infra
    // (~90% dos 'error' históricos) com julgamento de conteúdo.
    if (opts.excludeSystemErrors) { where.push('system_error = 0'); }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .prepare(
        `SELECT classifier_name, verdict, COUNT(*) AS count
         FROM quality_classifications ${whereSql}
         GROUP BY classifier_name, verdict
         ORDER BY classifier_name, verdict`,
      )
      .all(params) as Array<{ classifier_name: string; verdict: QualityVerdict; count: number }>;
  }

  /**
   * Contagem de falhas de INFRA do classifier (system_error=1) — saúde do
   * binding, exibida separada da distribuição de conteúdo (mig 202).
   */
  countSystemErrors(opts: { since?: string } = {}): number {
    const where: string[] = ['system_error = 1'];
    const params: Record<string, unknown> = {};
    if (opts.since) { where.push('created_at >= @since'); params.since = opts.since; }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM quality_classifications WHERE ${where.join(' AND ')}`)
      .get(params) as { n: number };
    return row.n;
  }

  pruneOlderThan(cutoff: string): number {
    const result = this.db
      .prepare('DELETE FROM quality_classifications WHERE created_at < ?')
      .run(cutoff);
    return Number(result.changes);
  }

  /** Drop ALL rows (the dashboard "Limpar tudo" action). */
  clearAll(): number {
    const result = this.db.prepare('DELETE FROM quality_classifications').run();
    return Number(result.changes);
  }
}
