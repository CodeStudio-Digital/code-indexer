/**
 * Offline, read-only report for agent-engineering interventions.
 *
 * Session inputs, tool evidence, review findings, and turn/cost metrics are
 * read exclusively from filesystem bundles. SQLite is opened only for the
 * essential project registry needed to locate project-scoped bundles.
 *
 * Usage:
 *   pnpm tsx scripts/eval-agent-engineering.ts [--db <path>] [--since <ISO>] [--json]
 */
import { resolve } from 'node:path';
import { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import {
  listFilesystemTurnTelemetry,
} from '@mcp/session-storage/fs-store/telemetry-dashboard.js';
import { loadConfig, mcpDataDir } from '@mcp/shared/utils/config.js';
import { CodeIndexDB } from '@mcp/store/db.js';

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const config = loadConfig();
const dbPath =
  arg('--db') ??
  process.env.MCP_DB_PATH ??
  config.dbPath ??
  resolve(
    process.env.USERPROFILE ?? process.env.HOME ?? '.',
    '.mcp-code-indexer/index.db',
  );
const since = arg('--since');
const asJson = process.argv.includes('--json');
const sinceMs = since == null ? Number.NaN : Date.parse(since);
if (since != null && !Number.isFinite(sinceMs)) {
  throw new Error('--since must be a valid ISO timestamp');
}

interface CohortRow {
  sessions: number;
  finish_evidence_nudges: number;
  bug_workflow_sessions: number;
  nudge_then_validation: number;
  avg_turns: number | null;
  total_cost_usd: number | null;
}

interface ReviewRow {
  unfulfilled_obligation: number;
  scope_creep: number;
  accepted: number;
  dismissed: number;
}

function isVerificationCommand(command: string): boolean {
  return /\b(test|typecheck|lint|build|vitest|pytest)\b/i.test(command);
}

async function main(): Promise<void> {
  const db = new CodeIndexDB(dbPath);
  try {
    const sessions = FsSessionStore.fromRoots({
      dataDir: mcpDataDir(),
      projectRootResolver: {
        resolveProjectRoot: (projectId) =>
          db.getProject(projectId)?.root_path,
        listProjectRoots: () =>
          db.listProjects().map((project) => ({
            project_id: project.id,
            root_path: project.root_path,
          })),
      },
    });
    await sessions.ensureCatalog();
    const entries = sessions.catalog.list().filter(
      (entry) =>
        entry.session.kind === 'coder' &&
        (!Number.isFinite(sinceMs) ||
          Date.parse(entry.session.created_at) >= sinceMs),
    );

    const rows = await Promise.all(
      entries.map(async (entry) => {
        const [inputs, turns, commands, comments] = await Promise.all([
          sessions.listSessionInputs(entry.session.id),
          listFilesystemTurnTelemetry(sessions, entry.session.id),
          sessions.getCommandTrail(
            entry.session.id,
            Number.MAX_SAFE_INTEGER,
          ),
          sessions.listComments('coder', entry.session.id),
        ]);
        const nudged = inputs.some(
          (input) =>
            input.source_label === 'reminder:finish-evidence',
        );
        const bugfix = inputs.some(
          (input) =>
            input.kind === 'preflight' &&
            input.meta?.task_kind === 'bugfix',
        );
        return {
          nudged,
          bugfix,
          corrected:
            nudged &&
            commands.some(
              (command) =>
                !command.isError &&
                isVerificationCommand(command.command),
            ),
          turns,
          comments,
        };
      }),
    );

    const allTurns = rows.flatMap((row) =>
      row.turns.filter(
        (turn) =>
          !Number.isFinite(sinceMs) ||
          Date.parse(turn.created_at) >= sinceMs,
      ),
    );
    const cohort: CohortRow = {
      sessions: rows.length,
      finish_evidence_nudges: rows.filter((row) => row.nudged).length,
      bug_workflow_sessions: rows.filter((row) => row.bugfix).length,
      nudge_then_validation: rows.filter((row) => row.corrected).length,
      avg_turns:
        rows.length === 0 ? null : allTurns.length / rows.length,
      total_cost_usd: allTurns.reduce(
        (total, turn) =>
          total + (turn.estimated_cost_usd ?? 0),
        0,
      ),
    };

    const comments = rows.flatMap((row) => row.comments);
    const review: ReviewRow = {
      unfulfilled_obligation: comments.filter(
        (comment) => comment.kind === 'unfulfilled_obligation',
      ).length,
      scope_creep: comments.filter(
        (comment) => comment.kind === 'scope_creep',
      ).length,
      accepted: comments.filter(
        (comment) => comment.status === 'accepted',
      ).length,
      dismissed: comments.filter(
        (comment) => comment.status === 'dismissed',
      ).length,
    };

    const nudgeCorrectionRate =
      cohort.finish_evidence_nudges > 0
        ? cohort.nudge_then_validation /
          cohort.finish_evidence_nudges
        : null;
    const report = {
      project_registry_db: dbPath,
      session_storage: 'filesystem',
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
        unfulfilled_obligation_findings:
          review.unfulfilled_obligation,
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
      return;
    }
    const pct = (value: number | null): string =>
      value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
    const num = (value: number | null): string =>
      value == null ? 'n/a' : value.toFixed(2);
    console.log(
      `agent-engineering eval — filesystem sessions; project registry=${dbPath}; since=${report.since}`,
    );
    console.log(`  sessions: ${report.sessions}`);
    console.log('  finish-evidence:');
    console.log(
      `    nudged sessions:       ${cohort.finish_evidence_nudges}`,
    );
    console.log(
      `    nudge correction rate: ${pct(nudgeCorrectionRate)}`,
    );
    console.log('  bug workflow:');
    console.log(
      `    bugfix sessions:       ${cohort.bug_workflow_sessions}`,
    );
    console.log('  scope/obligation review findings:');
    console.log(
      `    unfulfilled_obligation: ${review.unfulfilled_obligation}`,
    );
    console.log(`    scope_creep:            ${review.scope_creep}`);
    console.log(
      `    accepted / dismissed:   ${review.accepted} / ${review.dismissed}`,
    );
    console.log('  cost:');
    console.log(
      `    avg turns:              ${num(cohort.avg_turns)}`,
    );
    console.log(
      `    total est. USD:         ${num(cohort.total_cost_usd)}`,
    );
  } finally {
    db.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
