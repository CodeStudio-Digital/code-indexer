import { MasterHumanInteraction } from './master-human-interaction.js';
/**
 * HumanInTheLoop — tracks pending plan / question / tasks interactions
 * that require approval from the master (for subordinates) or the human
 * (for the master itself).
 *
 * Responsibilities:
 *   - Own the pendingPlans / pendingQuestions / pendingTasks maps
 *   - Wire runner events to their corresponding pending registries
 *   - Resolve pending interactions (approve/reject/answer)
 *
 * Design note: subordinate interceptions need to notify the master when
 * the subordinate is blocked — that's done via `IMasterNotifier` so the
 * two services stay decoupled.
 */

import type { RunCoderHandle } from '@mcp/code-agent/index/types.js';

import type { IAgentStatusUpdater, IBoardPoster, IMasterNotifier, IMetaBusPublisher } from '@mcp/company/services/ports.js';
import type { MasterAttention } from '@mcp/company/services/MasterAttention.js';
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import { isAutonomyActionAllowed, resolveAutonomy } from '@mcp/company/services/autonomy/autonomy-config.js';
import type { AutonomyProvider } from '@mcp/company/services/autonomy/autonomy-provider.js';
import { ApprovalBatcher, formatPendingPlansSummary } from '@mcp/company/services/approval-batcher.js';

interface PendingPlan {
  agentRunId: string;
  role: string;
  planText: string;
  toolUseId: string;
  resolve: (response: string) => void;
}

interface PendingQuestion {
  agentRunId: string;
  role: string;
  question: string;
  options?: Array<{ label: string; value: string }>;
  allowFreeform?: boolean;
  resolve: (response: string) => void;
}

interface PendingTasks {
  agentRunId: string;
  role: string;
  summary: string;
  tasks: unknown[];
  resolve: (response: string) => void;
}

export class HumanInTheLoop {
  private readonly masterInteractions: MasterHumanInteraction;

  private readonly pendingPlans = new Map<string, PendingPlan>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly pendingTasks = new Map<string, PendingTasks>();

  /**
   * B7 — agentRunId → latest plan approval. Fed by BOTH approval paths
   * (fast-path auto-approve and `resolvePlan(approved=true)`); a newly
   * POSTED plan invalidates the previous approval (the subordinate is
   * re-planning), and a rejection clears it. Consumed by the QA plan
   * gate (`qa_start_run` refuses to create a run without an entry).
   * Cleared in `clearForAgent` / `clearAll` (abort, pause, finalize).
   */
  private readonly approvedPlans = new Map<string, { at: number; auto: boolean }>();

  /**
   * C4 — batches the master notification when SEVERAL plans are pending at
   * once: the first pending plan is still notified immediately (unchanged
   * path); from the second on, one 5s window aggregates everything still
   * pending into a single summary (see `flushPendingPlanSummary`). Only
   * reachable when the session turned plan auto-approve off.
   */
  private readonly planBatcher = new ApprovalBatcher({
    flush: () => this.flushPendingPlanSummary(),
  });
  constructor(
    private readonly bus: IMetaBusPublisher,
    private readonly board: IBoardPoster,
    private readonly status: IAgentStatusUpdater,
    private readonly master: IMasterNotifier,
    private readonly attention: MasterAttention,
    private readonly ctx: SessionContext,
    /**
     * C2 — per-session autonomy config, consulted per plan_posted so
     * `freeze` / a session allowlist act LIVE. Optional: legacy callers
     * and narrow test fixtures fall back to env+defaults.
     */
    private readonly autonomy?: Pick<AutonomyProvider, 'get'>,
  ) {
    this.masterInteractions = new MasterHumanInteraction(bus, board, status, master, ctx);
  }
  wireMasterPlan(...args: Parameters<MasterHumanInteraction['wireMasterPlan']>) {
    return this.masterInteractions.wireMasterPlan(...args);
  }

  wireMasterQuestion(...args: Parameters<MasterHumanInteraction['wireMasterQuestion']>) {
    return this.masterInteractions.wireMasterQuestion(...args);
  }

  respondToMasterPlan(...args: Parameters<MasterHumanInteraction['respondToMasterPlan']>) {
    return this.masterInteractions.respondToMasterPlan(...args);
  }

  respondToMasterQuestion(...args: Parameters<MasterHumanInteraction['respondToMasterQuestion']>) {
    return this.masterInteractions.respondToMasterQuestion(...args);
  }

  cancelPendingMasterPrompts(...args: Parameters<MasterHumanInteraction['cancelPendingMasterPrompts']>) {
    return this.masterInteractions.cancelPendingMasterPrompts(...args);
  }

  consumeMasterShouldContinue(...args: Parameters<MasterHumanInteraction['consumeMasterShouldContinue']>) {
    return this.masterInteractions.consumeMasterShouldContinue(...args);
  }

  // ─── Subordinate plan / question / tasks ────────────────────────

  /**
   * Fast-path auto-approval (Phase 3 — break the master serialization funnel).
   *
   * C2 — resolved through the per-session autonomy config: default `'*'`
   * (every role's PLAN self-approves). Precedence: session
   * `autonomy.autoApproveRoles` > env `MCP_COMPANY_AUTO_APPROVE_ROLES`
   * (present env overrides — explicit empty string = off) > default `'*'`.
   * `freeze: true` NEVER auto-approves, whatever the role list says.
   *
   * Scope is intentionally PLANS only — task lists (multi-step commitments)
   * still go through the master. Read per-call (cached provider, invalidated
   * on config PATCH) so the operator can flip it live without a restart.
   * Fallback to env+defaults when no provider was injected (legacy callers).
   */
  private shouldAutoApprovePlan(role: string): boolean {
    const cfg = this.autonomy
      ? this.autonomy.get()
      : resolveAutonomy(null, process.env);
    // Covers freeze (always deny) and null/[] role lists (nobody approves).
    if (!isAutonomyActionAllowed(cfg, 'autoApprove')) return false;
    if (cfg.autoApproveRoles === '*') return true;
    return Array.isArray(cfg.autoApproveRoles) && cfg.autoApproveRoles.includes(role);
  }

  wireSubordinatePlan(handle: RunCoderHandle, agentRunId: string, role: string): void {
    handle.runner.on('plan_posted', (block: { plan: string; toolUseId?: string }) => {
      // B7 — a new plan supersedes any previous approval: until this one
      // is resolved, the agent has NO approved plan (QA gate blocks).
      this.approvedPlans.delete(agentRunId);
      // Fast-path: a trusted role's plan is approved without the master turn.
      if (this.shouldAutoApprovePlan(role)) {
        this.approvedPlans.set(agentRunId, { at: Date.now(), auto: true });
        this.bus.publish('subordinate_plan_posted', { agentRunId, role, plan: block.plan });
        // C1 — organism visibility: a dedicated event (besides the board
        // post) so the dashboard autonomy feed can render the auto-approval.
        // `at` is server-stamped so SSE replays de-dup client-side.
        this.bus.publish('plan_auto_approved', { agentRunId, role, at: Date.now() });
        this.board.post(role, agentRunId, 'message',
          `[auto-approved] ${role}'s plan was auto-approved (trusted role) — proceeding without a master round-trip.`);
        handle.runner.provideUserInput(
          JSON.stringify({ approved: true, feedback: 'Auto-approved: trusted role (autonomy.autoApproveRoles).' }),
        );
        this.status.setStatus(agentRunId, 'running');
        return;
      }
      this.status.setStatus(agentRunId, 'waiting_plan');
      this.board.post(role, agentRunId, 'question',
        `[@master] ${role} submitted plan for review:\n\n${block.plan}`);
      this.bus.publish('subordinate_plan_posted', { agentRunId, role, plan: block.plan });

      this.pendingPlans.set(agentRunId, {
        agentRunId,
        role,
        planText: block.plan,
        toolUseId: block.toolUseId ?? '',
        resolve: (response) => {
          handle.runner.provideUserInput(response);
          this.status.setStatus(agentRunId, 'running');
        },
      });

      // C4 — when another plan is ALREADY pending, don't fire one more
      // notify per plan: arm the batcher and let ONE aggregated summary
      // cover the whole burst (approve_subordinate_plans handles it in a
      // single master turn). The FIRST pending plan keeps the immediate,
      // verbatim notification below — a single plan never waits.
      if (this.pendingPlans.size > 1) {
        this.planBatcher.signal();
        return;
      }

      this.master.notify(this.buildSinglePlanNotice(agentRunId, role, block.plan));
      this.attention.signal({ kind: 'plan', agentRunId, role });
    });
  }

  /** The classic one-plan `[SYSTEM]` notification (immediate path + flush fallback). */
  private buildSinglePlanNotice(agentRunId: string, role: string, plan: string): string {
    return (
      `[SYSTEM] @${role} (agent_run_id=${agentRunId}) submitted a plan for approval and is BLOCKED.\n` +
      `Plan:\n${plan}\n` +
      `Use approve_subordinate_plan(agent_run_id=${agentRunId}, approved=true/false, feedback="...") to respond.`
    );
  }

  /**
   * C4 — batcher flush: aggregate every plan STILL pending into one master
   * notification. Plans resolved (or cleared by an abort) during the window
   * drop out naturally because we re-read `pendingPlans` here. Degenerates
   * to the classic single-plan message when only one survived.
   */
  private flushPendingPlanSummary(): void {
    const entries = [...this.pendingPlans.values()];
    if (entries.length === 0) return;
    this.master.notify(
      entries.length === 1
        ? this.buildSinglePlanNotice(entries[0].agentRunId, entries[0].role, entries[0].planText)
        : formatPendingPlansSummary(entries),
    );
    for (const p of entries) {
      this.attention.signal({ kind: 'plan', agentRunId: p.agentRunId, role: p.role });
    }
  }

  wireSubordinateQuestion(handle: RunCoderHandle, agentRunId: string, role: string): void {
    handle.runner.on('question_posted', (block: {
      id: string;
      question: string;
      options?: Array<{ label: string; value: string }>;
      allowFreeform?: boolean;
    }) => {
      this.status.setStatus(agentRunId, 'waiting_question');
      const optionsText = block.options?.length
        ? `\nOptions: ${block.options.map((o) => o.label).join(', ')}`
        : '';
      this.board.post(role, agentRunId, 'question',
        `[@master] ${role} asks: ${block.question}${optionsText}`);
      this.bus.publish('subordinate_question_posted', {
        agentRunId, role, question: block.question,
        options: block.options, allowFreeform: block.allowFreeform,
      });

      this.pendingQuestions.set(agentRunId, {
        agentRunId, role,
        question: block.question,
        options: block.options,
        allowFreeform: block.allowFreeform,
        resolve: (response) => {
          handle.runner.provideUserInput(response);
          this.status.setStatus(agentRunId, 'running');
        },
      });

      this.master.notify(
        `[SYSTEM] @${role} (agent_run_id=${agentRunId}) is asking a question and BLOCKED waiting for your answer.\n` +
        `Question: "${block.question}"${optionsText}\n` +
        `Use answer_subordinate_question(agent_run_id=${agentRunId}, answer="...") to respond. ` +
        `If you cannot answer, use ask_user to escalate the question to the human, then relay the human's response.`,
      );
      this.attention.signal({ kind: 'question', agentRunId, role });
    });
  }

  wireSubordinateTasks(handle: RunCoderHandle, agentRunId: string, role: string): void {
    handle.runner.on('tasks_posted', (block: {
      tool_use_id?: string;
      summary?: string;
      tasks?: unknown[];
    }) => {
      const summary = block.summary ?? '(no summary)';
      const tasks = block.tasks ?? [];

      this.status.setStatus(agentRunId, 'waiting_tasks');
      this.board.post(role, agentRunId, 'question',
        `[@master] ${role} submitted task list for review:\n\n${summary}`);
      this.bus.publish('subordinate_tasks_posted', { agentRunId, role, summary, tasks });

      this.pendingTasks.set(agentRunId, {
        agentRunId, role, summary, tasks,
        resolve: (response) => {
          handle.runner.provideUserInput(response);
          this.status.setStatus(agentRunId, 'running');
        },
      });

      this.master.notify(
        `[SYSTEM] @${role} (agent_run_id=${agentRunId}) submitted a task list for approval and is BLOCKED.\n` +
        `Summary: "${summary}"\n` +
        `Use approve_subordinate_tasks(agent_run_id=${agentRunId}, approved=true/false, feedback="...") to respond.`,
      );
      this.attention.signal({ kind: 'tasks', agentRunId, role });
    });
  }

  // ─── Resolvers ──────────────────────────────────────────────────

  resolvePlan(agentRunId: string, approved: boolean, feedback?: string): boolean {
    const pending = this.pendingPlans.get(agentRunId);
    if (!pending) return false;

    pending.resolve(JSON.stringify({ approved, feedback: feedback ?? '' }));
    this.pendingPlans.delete(agentRunId);

    // B7 — feed the plan-approval registry consumed by the QA gate.
    if (approved) this.approvedPlans.set(agentRunId, { at: Date.now(), auto: false });
    else this.approvedPlans.delete(agentRunId);

    this.board.post('master', this.master.agentRunId, 'decision',
      `[@${pending.role}] Plan ${approved ? 'APPROVED' : 'REJECTED'}${feedback ? `: ${feedback}` : ''}`);
    return true;
  }

  resolveQuestion(agentRunId: string, answer: string): boolean {
    const pending = this.pendingQuestions.get(agentRunId);
    if (!pending) return false;

    pending.resolve(JSON.stringify({ answer }));
    this.pendingQuestions.delete(agentRunId);

    this.board.post('master', this.master.agentRunId, 'decision',
      `[@${pending.role}] Answered question: ${answer}`);
    this.bus.publish('subordinate_question_resolved', { agentRunId });
    return true;
  }

  resolveTasks(
    agentRunId: string,
    approved: boolean,
    feedback?: string,
    executionMode?: string,
  ): boolean {
    const pending = this.pendingTasks.get(agentRunId);
    if (!pending) return false;

    pending.resolve(JSON.stringify({
      approved,
      feedback: feedback ?? '',
      execution_mode: executionMode ?? 'inline',
    }));
    this.pendingTasks.delete(agentRunId);

    this.board.post('master', this.master.agentRunId, 'decision',
      `[@${pending.role}] Tasks ${approved ? 'APPROVED' : 'REJECTED'}${feedback ? `: ${feedback}` : ''}`);
    this.bus.publish('subordinate_tasks_resolved', { agentRunId });
    return true;
  }

  // ─── Queries ────────────────────────────────────────────────────

  hasPendingPlan(agentRunId: string): boolean { return this.pendingPlans.has(agentRunId); }
  hasPendingQuestion(agentRunId: string): boolean { return this.pendingQuestions.has(agentRunId); }
  hasPendingTasks(agentRunId: string): boolean { return this.pendingTasks.has(agentRunId); }

  /**
   * B7 — latest plan approval for this agent run, or null when the agent
   * has no approved plan (never submitted, pending, rejected, or the
   * approval was cleared by abort/pause). `auto` tells the caller HOW it
   * was approved (fast-path autonomy vs. explicit master/human decision)
   * so `qa_start_run` can persist `plan_gate='auto' | 'approved'`.
   */
  hasApprovedPlan(agentRunId: string): { approved: boolean; auto: boolean } | null {
    const entry = this.approvedPlans.get(agentRunId);
    return entry ? { approved: true, auto: entry.auto } : null;
  }

  /** Clear all pending entries for a given agent (used on abort). */
  clearForAgent(agentRunId: string): void {
    this.pendingPlans.delete(agentRunId);
    this.pendingQuestions.delete(agentRunId);
    this.pendingTasks.delete(agentRunId);
    this.approvedPlans.delete(agentRunId);
  }

  /** Clear everything (used on abortAll / finalize). */
  clearAll(): void {
    this.planBatcher.cancel(); // C4 — don't flush a summary for aborted plans
    this.pendingPlans.clear();
    this.pendingQuestions.clear();
    this.pendingTasks.clear();
    this.approvedPlans.clear();
  }
}
