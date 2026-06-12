/**
 * Company-level memory consolidation (Mem C, phase A2).
 *
 * The board is where a company session's real knowledge surfaces —
 * decisions, blockers, deliverables — but it dies with the session.
 * `consolidateBoardToMemory` runs once at `finalize_subordinates` and
 * pushes a bounded digest of those entries through the memory ports'
 * distiller, so the durable lessons land in project snapshots and reach
 * every future session (company or single-chat) on the same project.
 *
 * Attribution: each board entry maps to its author's project(s) via
 * `agent_run_id → project_ids_json`; master/system posts (no run or the
 * master run) attribute to ALL session projects. The digest is grouped
 * per project because memory is project-scoped.
 *
 * Failure posture: best-effort fire-and-forget. The distiller's semantic
 * dedup (MemoryExtractor) absorbs double-finalize; any error is swallowed
 * — finalization must never fail because consolidation did.
 */
import { getCompanyMemoryPorts } from './ports.js';

interface BoardEntryLike {
  agent_run_id: number | null;
  author_role: string;
  kind: string;
  content: string;
}

interface AgentRunLike {
  id: number;
  role: string;
  project_ids_json: string;
}

export interface ConsolidateBoardDeps {
  companySessionId: number;
  companyStore: {
    readBoard(companySessionId: number, opts?: { sinceId?: number; limit?: number }): BoardEntryLike[];
    listAgentRuns(companySessionId: number): AgentRunLike[];
  };
  db: {
    getProjectMemoryEnabled(projectId: number): boolean;
    getProject(id: number): { name: string } | null | undefined;
  };
  projects: ReadonlyArray<{ project_id: number }>;
}

/** Kinds worth distilling — chatter ('message') stays on the board. */
const DISTILL_KINDS = new Set(['decision', 'blocker', 'deliverable']);
const ENTRY_CHAR_CAP = 600;
const SUMMARY_CHAR_CAP = 8_000;
const BOARD_READ_LIMIT = 400;

function capEntry(e: BoardEntryLike): string {
  const text = e.content.length > ENTRY_CHAR_CAP ? `${e.content.slice(0, ENTRY_CHAR_CAP)}…` : e.content;
  return `[${e.kind} @${e.author_role}] ${text}`;
}

/**
 * Distill the session board into per-project memory. Returns counts for
 * logging/tests; never throws.
 */
export async function consolidateBoardToMemory(
  deps: ConsolidateBoardDeps,
): Promise<{ projects: number; entries: number }> {
  try {
    const ports = getCompanyMemoryPorts();
    if (!ports) return { projects: 0, entries: 0 };
    if (!(await ports.runEndMemory.isConfigured())) return { projects: 0, entries: 0 };

    const entries = deps.companyStore
      .readBoard(deps.companySessionId, { limit: BOARD_READ_LIMIT })
      .filter((e) => DISTILL_KINDS.has(e.kind));
    if (entries.length === 0) return { projects: 0, entries: 0 };

    const sessionProjectIds = deps.projects.map((p) => p.project_id);
    const runProjects = new Map<number, number[]>();
    for (const run of deps.companyStore.listAgentRuns(deps.companySessionId)) {
      try {
        const ids = JSON.parse(run.project_ids_json) as number[];
        // The master's run row lists every session project — same effect
        // as the master/system fallback below.
        runProjects.set(run.id, Array.isArray(ids) && ids.length > 0 ? ids : sessionProjectIds);
      } catch {
        runProjects.set(run.id, sessionProjectIds);
      }
    }

    // Group capped entry lines per project.
    const perProject = new Map<number, { lines: string[]; blockers: string[] }>();
    const bucketFor = (projectId: number): { lines: string[]; blockers: string[] } => {
      let b = perProject.get(projectId);
      if (!b) {
        b = { lines: [], blockers: [] };
        perProject.set(projectId, b);
      }
      return b;
    };
    for (const entry of entries) {
      const projectIds =
        (entry.agent_run_id != null ? runProjects.get(entry.agent_run_id) : undefined) ??
        sessionProjectIds;
      const line = capEntry(entry);
      for (const pid of projectIds) {
        const bucket = bucketFor(pid);
        bucket.lines.push(line);
        if (entry.kind === 'blocker') bucket.blockers.push(line);
      }
    }

    let consolidatedProjects = 0;
    for (const [projectId, bucket] of perProject) {
      if (!deps.db.getProjectMemoryEnabled(projectId)) continue;
      const projectName = deps.db.getProject(projectId)?.name ?? `project-${projectId}`;
      let summary = bucket.lines.join('\n');
      if (summary.length > SUMMARY_CHAR_CAP) summary = `${summary.slice(0, SUMMARY_CHAR_CAP)}…`;
      // No toolTrail on purpose: the procedure distiller self-skips — board
      // posts carry decisions/lessons, not verified command recipes.
      await ports.runEndMemory.extractAndPersist(projectId, projectName, {
        primaryRequest: `Company session ${deps.companySessionId} — board consolidation at finalize`,
        summary,
        errorsAndFixes: bucket.blockers.length > 0 ? bucket.blockers : undefined,
        succeeded: true,
      });
      consolidatedProjects += 1;
    }
    return { projects: consolidatedProjects, entries: entries.length };
  } catch {
    return { projects: 0, entries: 0 };
  }
}
