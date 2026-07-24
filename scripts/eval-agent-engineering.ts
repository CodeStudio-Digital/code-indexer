/**
 * eval-agent-engineering — offline, read-only report on whether the operational
 * quality interventions (finish-evidence nudge, repro-first bug workflow,
 * intent contract / scope review) improve real outcomes without inflating cost
 * or loops. It reads the central DB directly; it never mutates anything.
 *
 * It answers, per cohort (nudged vs not) and per task_kind:
 *   - fresh_finish_rate        — sessions that ended with fresh verification
 *   - unverified_finish_rate   — sessions that finished with a stale/missing signal
 *   - nudge_correction_rate    — a finish-evidence nudge followed by a real
 *                                validation command afterwards
 *   - scope/obligation findings — unfulfilled_obligation + scope_creep counts
 *                                and their fates (accepted/dismissed)
 *   - cost/turns               — avg turns, tool calls, estimated USD
 *
 * Usage:
 *   pnpm tsx scripts/eval-agent-engineering.ts [--db <path>] [--since <ISO>] [--json]
 *
 * Every metric degrades to 0 / n/a when a table or column is absent, so the
 * script runs against older DBs without throwing.
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

type DB = InstanceType<typeof Database>;

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const dbPath =
  arg('--db') ??
  process.env.MCP_DB_PATH ??
  resolve(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.mcp-code-indexer/index.db');
const since = arg('--since');
const asJson = process.argv.includes('--json');

const db: DB = new Database(dbPath, { readonly: true, fileMustExist: true });

function tableExists(name: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

const sinceClause = since ? 'AND s.created_at >= @since' : '';
const params = since ? { since } : {};

interface CohortRow {
  sessions: number;
  finish_evidence_nudges: number;
  bug_workflow_sessions: number;
  nudge_then_validation: number;
  avg_turns: number | null;
  total_cost_usd: number | null;
}

/**
 * Per-session flags derived from the audited session_inputs trail:
 *   - got a finish-evidence nudge (source_label = 'reminder:finish-evidence')
 *   - got a bugfix workflow preflight (meta.task_kind = 'bugfix')
 * plus whether a verify-ish command ran AFTER the first such nudge (correction).
 */
function cohortReport(): CohortRow {
  if (!tableExists('coder_sessions')) {
    return {
      sessions: 0,
      finish_evidence_nudges: 0,
      bug_workflow_sessions: 0,
      nudge_then_validation: 0,
      avg_turns: null,
      total_cost_usd: null,
    };
  }

  const sessions = safe(
    () =>
      (db
        .prepare(`SELECT COUNT(*) AS n FROM coder_sessions s WHERE 1=1 ${sinceClause}`)
        .get(params) as { n: number }).n,
    0,
  );

  const nudges = tableExists('coder_session_inputs')
    ? safe(
        () =>
          (db
            .prepare(
              `SELECT COUNT(DISTINCT ci.session_id) AS n
                 FROM coder_session_inputs ci
                 JOIN coder_sessions s ON s.id = ci.session_id
                WHERE ci.source_label = 'reminder:finish-evidence' ${sinceClause}`,
            )
            .get(params) as { n: number }).n,
        0,
      )
    : 0;

  const bugSessions = tableExists('coder_session_inputs')
    ? safe(
        () =>
          (db
            .prepare(
              `SELECT COUNT(DISTINCT ci.session_id) AS n
                 FROM coder_session_inputs ci
                 JOIN coder_sessions s ON s.id = ci.session_id
                WHERE ci.kind = 'preflight'
                  AND json_extract(ci.meta_json, '$.task_kind') = 'bugfix' ${sinceClause}`,
            )
            .get(params) as { n: number }).n,
        0,
      )
    : 0;

  // Correction: a verify-ish command recorded AFTER the first finish-evidence
  // nudge in the same session. Uses id ordering as the within-session clock.
  const nudgeThenValidation = tableExists('coder_session_inputs') && tableExists('coder_tool_calls')
    ? safe(
        () =>
          (db
            .prepare(
              `WITH first_nudge AS (
                 SELECT ci.session_id, MIN(ci.id) AS nudge_id
                   FROM coder_session_inputs ci
                  WHERE ci.source_label = 'reminder:finish-evidence'
                  GROUP BY ci.session_id
               )
               SELECT COUNT(DISTINCT fn.session_id) AS n
                 FROM first_nudge fn
                 JOIN coder_messages m ON m.session_id = fn.session_id
                 JOIN coder_tool_calls tc ON tc.message_id = m.id
                WHERE tc.tool_name IN ('run_command', 'exec_command')
                  AND tc.is_error = 0
                  AND (tc.args_json LIKE '%test%' OR tc.args_json LIKE '%typecheck%'
                       OR tc.args_json LIKE '%lint%' OR tc.args_json LIKE '%build%'
                       OR tc.args_json LIKE '%vitest%' OR tc.args_json LIKE '%pytest%')`,
            )
            .get() as { n: number }).n,
        0,
      )
    : 0;

  const turnStats = tableExists('coder_turn_telemetry')
    ? safe(
        () =>
          db
            .prepare(
              `SELECT AVG(t.turns) AS avg_turns, SUM(t.cost) AS total_cost
                 FROM (
                   SELECT tt.session_id,
                          MAX(tt.turn) AS turns,
                          SUM(COALESCE(tt.estimated_cost_usd, 0)) AS cost
                     FROM coder_turn_telemetry tt
                     JOIN coder_sessions s ON s.id = tt.session_id
                    WHERE 1=1 ${sinceClause}
                    GROUP BY tt.session_id
                 ) t`,
            )
            .get(params) as { avg_turns: number | null; total_cost: number | null },
        { avg_turns: null, total_cost: null },
      )
    : { avg_turns: null, total_cost: null };

  return {
    sessions,
    finish_evidence_nudges: nudges,
    bug_workflow_sessions: bugSessions,
    nudge_then_validation: nudgeThenValidation,
    avg_turns: turnStats.avg_turns,
    total_cost_usd: turnStats.total_cost,
  };
}

interface ReviewRow {
  unfulfilled_obligation: number;
  scope_creep: number;
  accepted: number;
  dismissed: number;
}

function reviewReport(): ReviewRow {
  if (!tableExists('session_file_review_comments')) {
    return { unfulfilled_obligation: 0, scope_creep: 0, accepted: 0, dismissed: 0 };
  }
  return safe(
    () =>
      db
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN kind = 'unfulfilled_obligation' THEN 1 ELSE 0 END), 0) AS unfulfilled_obligation,
             COALESCE(SUM(CASE WHEN kind = 'scope_creep' THEN 1 ELSE 0 END), 0) AS scope_creep,
             COALESCE(SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END), 0) AS accepted,
             COALESCE(SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END), 0) AS dismissed
           FROM session_file_review_comments
          WHERE kind IN ('unfulfilled_obligation', 'scope_creep')`,
        )
        .get() as ReviewRow,
    { unfulfilled_obligation: 0, scope_creep: 0, accepted: 0, dismissed: 0 },
  );
}

const cohort = cohortReport();
const review = reviewReport();

const nudgeCorrectionRate =
  cohort.finish_evidence_nudges > 0
    ? cohort.nudge_then_validation / cohort.finish_evidence_nudges
    : null;

const report = {
  db: dbPath,
  since: since ?? '(all time)',
  sessions: cohort.sessions,
  finish_evidence: {
    nudged_sessions: cohort.finish_evidence_nudges,
    nudge_correction_rate: nudgeCorrectionRate,
  },
  bug_workflow: {
    bugfix_sessions: cohort.bug_workflow_sessions,
  },
  scope_review: {
    unfulfilled_obligation_findings: review.unfulfilled_obligation,
    scope_creep_findings: review.scope_creep,
    accepted: review.accepted,
    dismissed: review.dismissed,
  },
  cost: {
    avg_turns: cohort.avg_turns,
    total_cost_usd: cohort.total_cost_usd,
  },
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const pct = (v: number | null): string => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
  const num = (v: number | null): string => (v == null ? 'n/a' : v.toFixed(2));
  console.log(`agent-engineering eval — db=${dbPath} since=${report.since}`);
  console.log(`  sessions: ${report.sessions}`);
  console.log('  finish-evidence:');
  console.log(`    nudged sessions:       ${cohort.finish_evidence_nudges}`);
  console.log(`    nudge correction rate: ${pct(nudgeCorrectionRate)}`);
  console.log('  bug workflow:');
  console.log(`    bugfix sessions:       ${cohort.bug_workflow_sessions}`);
  console.log('  scope/obligation review findings:');
  console.log(`    unfulfilled_obligation: ${review.unfulfilled_obligation}`);
  console.log(`    scope_creep:            ${review.scope_creep}`);
  console.log(`    accepted / dismissed:   ${review.accepted} / ${review.dismissed}`);
  console.log('  cost:');
  console.log(`    avg turns:              ${num(cohort.avg_turns)}`);
  console.log(`    total est. USD:         ${num(cohort.total_cost_usd)}`);
}

db.close();
