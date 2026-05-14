/**
 * wait_agents — block until specified company subordinates reach a terminal
 * status. Cross-tier complement to `list_agents`: any agent in the session
 * (master or subordinate) can wait for any subset of subordinate paths.
 *
 * Mirrors codex's `wait_agent` API. The existing master tool
 * `wait_for_subordinates` is kept (it waits for the *whole* fleet); this
 * tool accepts an explicit path list and is available to subordinates too,
 * so peer-to-peer coordination doesn't have to round-trip through the
 * master.
 *
 * Behavior:
 *  - Accepts agent paths (`/root/master/<role>-<agentRunId>`) OR raw
 *    agent_run_ids. At least one entry is required.
 *  - Returns when every targeted agent reaches a terminal status
 *    (completed / failed / aborted / timed-out / finished).
 *  - Returns early — same as `wait_for_subordinates` — when any targeted
 *    agent posts a question/plan/tasks AND the caller is the master (only
 *    the master can resolve those). Subordinates do not get the early-
 *    return; they keep waiting for terminal status because they cannot
 *    answer peer prompts.
 *  - Standalone (non-company) sessions error out: nothing to wait on.
 */
import type { CoderTool, ToolContext, ToolResult } from '../core/tool.js';
import type { CompanyContext } from '../company/types.js';
import { ok, err } from '../core/tool.js';
import { maybeTerse } from './descriptions.js';
import { parseAgentPath } from './company/path-resolution.js';

const TERMINAL_STATUSES = new Set(['completed', 'finished', 'failed', 'aborted', 'timed_out', 'error']);

const WAIT_AGENTS_DESC =
  'Block until ALL specified subordinate agents reach a terminal status (completed/failed/aborted). ' +
  'Cross-tier — usable by master and subordinates. Read-only: never spawns or messages.\n' +
  '\n' +
  'Specify targets via `paths: ["/root/master/qa-7", "/root/master/frontend-9"]` or `agent_run_ids: [7, 9]` (or both).\n' +
  '\n' +
  "USE: master after spawning peers in parallel; subordinate that depends on a sibling's output before continuing.\n" +
  "USE: with a `timeout_minutes` cap when the agents may stall.\n" +
  "DON'T: wait on the master itself (`/root/master`) — it only completes when the session ends.\n" +
  "DON'T: poll. This tool is event-driven; calling it more than once per dependency turn is wasteful.";

interface NormalizedTarget {
  agentRunId: number;
  path: string;
}

function normalizeTargets(args: Record<string, unknown>, cc: CompanyContext): { targets: NormalizedTarget[]; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<number>();
  const targets: NormalizedTarget[] = [];

  const subs = (() => {
    try { return cc.orchestrator.listSubordinates(); } catch { return []; }
  })();
  const subById = new Map(subs.map((s) => [s.agentRunId, s]));

  const addId = (id: number, originLabel: string): void => {
    if (!Number.isFinite(id)) {
      errors.push(`${originLabel}: invalid agent_run_id`);
      return;
    }
    if (seen.has(id)) return;
    const sub = subById.get(id);
    if (!sub) {
      errors.push(`${originLabel}: agent_run_id=${id} not found among subordinates of this session`);
      return;
    }
    seen.add(id);
    targets.push({ agentRunId: id, path: `/root/master/${sub.role}-${id}` });
  };

  const paths = Array.isArray(args.paths) ? args.paths : [];
  for (const raw of paths) {
    if (typeof raw !== 'string') {
      errors.push(`paths: entries must be strings, got ${typeof raw}`);
      continue;
    }
    if (raw === '/root' || raw === '/root/master') {
      errors.push(`paths: '${raw}' has no terminal status — refuse to wait on master/root`);
      continue;
    }
    const id = parseAgentPath(raw);
    if (id === null) {
      errors.push(`paths: '${raw}' is not a recognized subordinate path (expected /root/master/<role>-<id>)`);
      continue;
    }
    addId(id, `paths['${raw}']`);
  }

  const ids = Array.isArray(args.agent_run_ids) ? args.agent_run_ids : [];
  for (const raw of ids) {
    const id = typeof raw === 'number' ? raw : Number(raw);
    addId(id, `agent_run_ids[${raw}]`);
  }

  return { targets, errors };
}

export const waitAgents: CoderTool = {
  name: 'wait_agents',
  description: maybeTerse(WAIT_AGENTS_DESC),
  source: 'native',
  mutates: false,
  // Blocks the runner waiting for events; never run two of these in parallel.
  parallelSafe: false,
  riskLevel: 'read',
  // Polling tool — exempt from per-arg dup-call cap and result-content dedup.
  // Repeated calls with the same paths/ids are the legitimate use case while
  // the targets are still running, and the result content is identical until
  // a status flips.
  repeatable: true,
  parameters: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        description: 'Agent paths as returned by list_agents (e.g. "/root/master/qa-7").',
        items: { type: 'string' },
      },
      agent_run_ids: {
        type: 'array',
        description: 'Raw agent_run_id numbers. Equivalent to paths; for callers that prefer ids.',
        items: { type: 'number' },
      },
      timeout_minutes: {
        type: 'number',
        description: 'Max minutes to wait before giving up (default 30).',
      },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const cc = ctx.companyContext;
    if (!cc) {
      return err('wait_agents: no companyContext on this session — there are no agents to wait on.');
    }

    const { targets, errors } = normalizeTargets(args, cc);
    if (errors.length > 0) {
      return err(`wait_agents: ${errors.join('; ')}`);
    }
    if (targets.length === 0) {
      return err('wait_agents: provide at least one of `paths` or `agent_run_ids`.');
    }

    const isMaster = cc.isMaster;
    const orchestrator = cc.orchestrator;
    const targetIds = new Set(targets.map((t) => t.agentRunId));

    const isTargetTerminal = (id: number): boolean => {
      const sub = orchestrator.listSubordinates().find((s) => s.agentRunId === id);
      if (!sub) return true; // gone from list → treat as terminal
      return TERMINAL_STATUSES.has(sub.status);
    };

    const checkAllDone = (): boolean => targets.every((t) => isTargetTerminal(t.agentRunId));

    if (checkAllDone()) {
      const summary = renderSummary(orchestrator, targets);
      return ok(`All targeted agents are already in terminal status:\n${summary}`);
    }

    const timeoutMs = ((args.timeout_minutes as number | undefined) ?? 30) * 60 * 1000;
    const deadline = Date.now() + timeoutMs;

    while (!checkAllDone()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const stillRunning = targets.filter((t) => !isTargetTerminal(t.agentRunId));
        return err(
          `wait_agents: timed out after ${args.timeout_minutes ?? 30}min. Still running: ${stillRunning.map((t) => t.path).join(', ')}.`,
        );
      }

      const event = await new Promise<
        | { kind: 'question' | 'plan' | 'tasks' | 'finished'; agentRunId: number; role: string }
        | { kind: 'timeout' }
      >((resolve) => {
        let done = false;
        const off = orchestrator.onSubordinateAttention((ev) => {
          if (done) return;
          // Subordinate↔subordinate inbox — never relevant here.
          if (ev.kind === 'inbox_answered') return;
          // Only react when the event is about a TARGET agent.
          if (!targetIds.has(ev.agentRunId)) return;
          done = true;
          clearTimeout(timer);
          off();
          resolve({ kind: ev.kind, agentRunId: ev.agentRunId, role: ev.role });
        });
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          off();
          resolve({ kind: 'timeout' });
        }, remaining);
      });

      // Master only: bail out early when a target asks for input — only the
      // master can resolve plan/question/tasks. Subordinates keep waiting.
      if (
        isMaster &&
        (event.kind === 'question' || event.kind === 'plan' || event.kind === 'tasks')
      ) {
        const verb =
          event.kind === 'question' ? 'answer_subordinate_question'
          : event.kind === 'plan' ? 'approve_subordinate_plan'
          : 'approve_subordinate_tasks';
        return ok(
          `wait_agents: subordinate @${event.role} (agent_run_id=${event.agentRunId}) needs attention — posted a ${event.kind}. ` +
          `Resolve with ${verb}, then call wait_agents again to keep waiting for the rest.`,
        );
      }
      // 'finished' / 'timeout' / subordinate-tier 'plan'|'question'|'tasks' → re-check.
    }

    const summary = renderSummary(orchestrator, targets);
    return ok(`All targeted agents finished:\n${summary}`);
  },
};

function renderSummary(
  orchestrator: CompanyContext['orchestrator'],
  targets: NormalizedTarget[],
): string {
  const subs = orchestrator.listSubordinates();
  return targets
    .map((t) => {
      const sub = subs.find((s) => s.agentRunId === t.agentRunId);
      const status = sub?.status ?? 'gone';
      const msg = sub?.statusMessage ? ` — ${sub.statusMessage}` : '';
      return `  - ${t.path} (run=${t.agentRunId}): ${status}${msg}`;
    })
    .join('\n');
}

export const waitAgentsTools: CoderTool[] = [waitAgents];
