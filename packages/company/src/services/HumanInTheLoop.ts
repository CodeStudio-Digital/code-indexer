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

import { randomUUID } from 'node:crypto';
import type { RunCoderHandle } from '@mcp/code-agent/index.js';
import { hashControlPlanePayload } from '@mcp/store/control-plane/index.js';
import type {
  IAgentStatusUpdater,
  IBoardPoster,
  IMasterNotifier,
  IMetaBusPublisher,
} from '@mcp/company/services/ports.js';
import type { MasterAttention } from '@mcp/company/services/MasterAttention.js';
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import {
  isAutonomyActionAllowed,
  resolveAutonomy,
} from '@mcp/company/services/autonomy/autonomy-config.js';
import type { AutonomyProvider } from '@mcp/company/services/autonomy/autonomy-provider.js';
import {
  ApprovalBatcher,
  formatPendingPlansSummary,
} from '@mcp/company/services/approval-batcher.js';
import type { MasterPrompt } from '@mcp/company/types.js';

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

  /** Set while the master itself is waiting on a human plan/question. */
  private masterShouldContinue = false;

  /**
   * Persistent prompt ids the master is currently blocked on.
   * Used so HTTP responders can resolve a specific prompt by id (idempotent
   * across reconnect/replay) and so we know which prompt to mark on
   * `respondTo*` when the caller doesn't supply an id.
   */
  private currentMasterPlanPromptId: string | null = null;
  private currentMasterQuestionPromptId: string | null = null;
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
  ) {}

  // ─── Master plan / question ─────────────────────────────────────

  wireMasterPlan(handle: RunCoderHandle): void {
    handle.runner.on('plan_posted', (block: { plan: string }) => {
      if (this.master.agentRunId != null) {
        this.status.setStatus(this.master.agentRunId, 'waiting_plan');
      }
      void this.ctx.companyFiles.createMasterPrompt({
        agent_run_id: this.master.agentRunId,
        kind: 'plan',
        body: block.plan,
        allow_freeform: true,
      }).then((prompt) => {
        this.currentMasterPlanPromptId = prompt.id;
        this.bus.publish('master_plan_posted', { prompt });
      }).catch((error) => {
        console.error(
          `[company s=${this.ctx.companySessionId}] failed to persist Master plan prompt:`,
          error,
        );
      });
    });
  }

  wireMasterQuestion(handle: RunCoderHandle): void {
    handle.runner.on('question_posted', (block: {
      id: string;
      question: string;
      options?: Array<{ label: string; value: string }>;
      allowFreeform?: boolean;
    }) => {
      if (this.master.agentRunId != null) {
        this.status.setStatus(this.master.agentRunId, 'waiting_question');
      }
      void this.ctx.companyFiles.createMasterPrompt({
        agent_run_id: this.master.agentRunId,
        kind: 'question',
        runner_block_id: block.id,
        body: block.question,
        options: block.options ?? null,
        allow_freeform: block.allowFreeform !== false,
      }).then((prompt) => {
        this.currentMasterQuestionPromptId = prompt.id;
        this.bus.publish('master_question_posted', { prompt });
      }).catch((error) => {
        console.error(
          `[company s=${this.ctx.companySessionId}] failed to persist Master question prompt:`,
          error,
        );
      });
    });
  }

  /**
   * Resolve the current master plan prompt with the human's decision.
   * `promptId` is optional: when omitted, resolves the most-recent pending
   * plan (back-compat path). Returns the resolved prompt, or null when
   * the prompt is not pending (already answered/cancelled — race with
   * shutdown) or the master runner is gone.
   */
  async respondToMasterPlan(
    approved: boolean,
    feedback?: string,
    promptId?: string,
    deliveryOpts?: { retryOutcomeUnknown?: boolean },
  ): Promise<MasterPrompt | null> {
    const handle = this.master.handle;
    if (!handle) return null;

    const targetId = promptId
      ?? this.currentMasterPlanPromptId
      ?? (await this.ctx.companyFiles.getPendingMasterPrompt('plan'))?.id
      ?? null;
    if (targetId == null) return null;
    const response = JSON.stringify({ approved, feedback: feedback ?? '' });
    const deliveryToken = randomUUID();
    const claim = await this.ctx.companyFiles.claimMasterPromptDelivery(
      targetId,
      'plan',
      deliveryToken,
      hashControlPlanePayload({
        kind: 'plan',
        approved,
        feedback: feedback ?? null,
      }),
      deliveryOpts,
    );
    if (claim.kind === 'not_pending') return null;
    if (claim.kind === 'payload_conflict') {
      throw this.deliveryPayloadConflictError(targetId, 'plan');
    }
    if (claim.kind !== 'claimed') {
      throw this.outcomeUnknownError(
        targetId,
        'plan',
        claim.kind === 'delivery_in_progress'
          ? 'another delivery is in progress or its acknowledgement was lost'
          : 'a previous delivery was not durably recorded',
      );
    }

    let updated: MasterPrompt | null;
    let delivered: boolean;
    try {
      delivered = handle.runner.provideUserInput(response);
    } catch (error) {
      await this.markOutcomeUnknown(targetId, deliveryToken);
      throw this.outcomeUnknownError(
        targetId,
        'plan',
        `runner delivery threw before acknowledgement: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!delivered) {
      // `false` is an authoritative pre-effect refusal. Leave the durable
      // prompt pending so the caller can safely retry once the runner waits.
      if (!await this.ctx.companyFiles.releaseMasterPromptDelivery(targetId, deliveryToken)) {
        throw this.outcomeUnknownError(targetId, 'plan', 'the delivery reservation could not be released');
      }
      return null;
    }

    try {
      updated = await this.ctx.companyFiles.completeMasterPromptDelivery(
        targetId,
        deliveryToken,
        { kind: 'plan', approved, feedback },
      );
    } catch (error) {
      await this.markOutcomeUnknown(targetId, deliveryToken);
      throw this.outcomeUnknownError(
        targetId,
        'plan',
        `durable update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!updated) {
      await this.markOutcomeUnknown(targetId, deliveryToken);
      throw this.outcomeUnknownError(targetId, 'plan', 'durable compare-and-set was rejected');
    }
    if (this.currentMasterPlanPromptId === targetId) this.currentMasterPlanPromptId = null;

    this.masterShouldContinue = true;
    this.master.setShouldContinue(true);
    if (this.master.agentRunId != null) {
      this.status.setStatus(this.master.agentRunId, 'running');
    }
    this.board.post('human', null, 'decision',
      `Plan ${approved ? 'APPROVED' : 'REJECTED'}${feedback ? `: ${feedback}` : ''}`);
    this.bus.publish('master_plan_resolved', { prompt: updated });
    return updated;
  }

  async respondToMasterQuestion(
    answer: string,
    promptId?: string,
    deliveryOpts?: { retryOutcomeUnknown?: boolean },
  ): Promise<MasterPrompt | null> {
    const handle = this.master.handle;
    if (!handle) return null;

    const targetId = promptId
      ?? this.currentMasterQuestionPromptId
      ?? (await this.ctx.companyFiles.getPendingMasterPrompt('question'))?.id
      ?? null;
    if (targetId == null) return null;
    const response = JSON.stringify({ answer });
    const deliveryToken = randomUUID();
    const claim = await this.ctx.companyFiles.claimMasterPromptDelivery(
      targetId,
      'question',
      deliveryToken,
      hashControlPlanePayload({ kind: 'question', answer }),
      deliveryOpts,
    );
    if (claim.kind === 'not_pending') return null;
    if (claim.kind === 'payload_conflict') {
      throw this.deliveryPayloadConflictError(targetId, 'question');
    }
    if (claim.kind !== 'claimed') {
      throw this.outcomeUnknownError(
        targetId,
        'question',
        claim.kind === 'delivery_in_progress'
          ? 'another delivery is in progress or its acknowledgement was lost'
          : 'a previous delivery was not durably recorded',
      );
    }

    let updated: MasterPrompt | null;
    let delivered: boolean;
    try {
      delivered = handle.runner.provideUserInput(response);
    } catch (error) {
      await this.markOutcomeUnknown(targetId, deliveryToken);
      throw this.outcomeUnknownError(
        targetId,
        'question',
        `runner delivery threw before acknowledgement: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!delivered) {
      if (!await this.ctx.companyFiles.releaseMasterPromptDelivery(targetId, deliveryToken)) {
        throw this.outcomeUnknownError(
          targetId,
          'question',
          'the delivery reservation could not be released',
        );
      }
      return null;
    }

    try {
      updated = await this.ctx.companyFiles.completeMasterPromptDelivery(
        targetId,
        deliveryToken,
        { kind: 'question', answer },
      );
    } catch (error) {
      await this.markOutcomeUnknown(targetId, deliveryToken);
      throw this.outcomeUnknownError(
        targetId,
        'question',
        `durable update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!updated) {
      await this.markOutcomeUnknown(targetId, deliveryToken);
      throw this.outcomeUnknownError(targetId, 'question', 'durable compare-and-set was rejected');
    }
    if (this.currentMasterQuestionPromptId === targetId) {
      this.currentMasterQuestionPromptId = null;
    }

    this.masterShouldContinue = true;
    this.master.setShouldContinue(true);
    if (this.master.agentRunId != null) {
      this.status.setStatus(this.master.agentRunId, 'running');
    }
    this.board.post('human', null, 'decision', `Human answered: ${answer}`);
    this.bus.publish('master_question_resolved', { prompt: updated });
    return updated;
  }

  private async markOutcomeUnknown(promptId: string, deliveryToken: string): Promise<void> {
    try {
      await this.ctx.companyFiles.markMasterPromptDeliveryOutcomeUnknown(
        promptId,
        deliveryToken,
      );
    } catch {
      // The original post-effect failure remains OUTCOME_UNKNOWN. A failed
      // secondary write must never turn into an automatic replay decision.
    }
  }

  private deliveryPayloadConflictError(
    promptId: string,
    kind: 'plan' | 'question',
  ): Error {
    const error = new Error(
      `Master ${kind} prompt ${promptId} has an uncertain delivery with a different payload`,
    ) as Error & { code: 'PROMPT_DELIVERY_PAYLOAD_CONFLICT' };
    error.name = 'MasterPromptDeliveryPayloadConflictError';
    error.code = 'PROMPT_DELIVERY_PAYLOAD_CONFLICT';
    return error;
  }

  private outcomeUnknownError(
    promptId: string,
    kind: 'plan' | 'question',
    detail: string,
  ): Error {
    const error = new Error(
      `Master ${kind} response outcome is unknown for prompt ${promptId}: ${detail}`,
    ) as Error & { code: 'OUTCOME_UNKNOWN' };
    error.name = 'MasterPromptOutcomeUnknownError';
    error.code = 'OUTCOME_UNKNOWN';
    return error;
  }

  /**
   * Cancel every still-pending master prompt for this session and emit
   * `master_prompt_cancelled` events. Called on session abort / master end
   * so dashboards can transition cards from "pending" to "cancelled".
   */
  async cancelPendingMasterPrompts(): Promise<MasterPrompt[]> {
    const cancelled = await this.ctx.companyFiles.cancelPendingMasterPrompts();
    for (const p of cancelled) {
      this.bus.publish('master_prompt_cancelled', { prompt: p });
    }
    if (cancelled.length > 0) {
      this.currentMasterPlanPromptId = null;
      this.currentMasterQuestionPromptId = null;
    }
    return cancelled;
  }

  consumeMasterShouldContinue(): boolean {
    const v = this.masterShouldContinue;
    this.masterShouldContinue = false;
    return v;
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

      // Wake the master in real time so `wait_for_subordinates` returns
      // instead of polling until the subordinate eventually completes.
      this.master.handle?.runner.interruptWait({ kind: 'plan', agentRunId, role });
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
    for (const p of entries) {
      this.master.handle?.runner.interruptWait({
        kind: 'plan', agentRunId: p.agentRunId, role: p.role,
      });
    }
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

      // Interrupt any pending waitForUserInput BEFORE enqueueing the user
      // message. Otherwise pushUserMessage + interruptWait race and the model
      // may process the stale ask_user result and the new notification out of
      // order, leading to a stuck state where the subordinate is never
      // answered.
      this.master.handle?.runner.interruptWait({ kind: 'question', agentRunId, role });
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

      // Interrupt FIRST, then notify — see wireSubordinateQuestion for rationale.
      this.master.handle?.runner.interruptWait({ kind: 'tasks', agentRunId, role });
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
