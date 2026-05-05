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

import type { RunCoderHandle } from '../../index.js';
import type {
  IAgentStatusUpdater,
  IBoardPoster,
  IMasterNotifier,
  IMetaBusPublisher,
} from './ports.js';
import type { MasterAttention } from './MasterAttention.js';
import type { SessionContext } from './SessionContext.js';
import type { MasterPrompt } from '../types.js';

interface PendingPlan {
  agentRunId: number;
  role: string;
  planText: string;
  toolUseId: string;
  resolve: (response: string) => void;
}

interface PendingQuestion {
  agentRunId: number;
  role: string;
  question: string;
  options?: Array<{ label: string; value: string }>;
  allowFreeform?: boolean;
  resolve: (response: string) => void;
}

interface PendingTasks {
  agentRunId: number;
  role: string;
  summary: string;
  tasks: unknown[];
  resolve: (response: string) => void;
}

export class HumanInTheLoop {
  private readonly pendingPlans = new Map<number, PendingPlan>();
  private readonly pendingQuestions = new Map<number, PendingQuestion>();
  private readonly pendingTasks = new Map<number, PendingTasks>();

  /** Set while the master itself is waiting on a human plan/question. */
  private masterShouldContinue = false;

  /**
   * Persistent prompt ids the master is currently blocked on.
   * Used so HTTP responders can resolve a specific prompt by id (idempotent
   * across reconnect/replay) and so we know which prompt to mark on
   * `respondTo*` when the caller doesn't supply an id.
   */
  private currentMasterPlanPromptId: number | null = null;
  private currentMasterQuestionPromptId: number | null = null;

  constructor(
    private readonly bus: IMetaBusPublisher,
    private readonly board: IBoardPoster,
    private readonly status: IAgentStatusUpdater,
    private readonly master: IMasterNotifier,
    private readonly attention: MasterAttention,
    private readonly ctx: SessionContext,
  ) {}

  // ─── Master plan / question ─────────────────────────────────────

  wireMasterPlan(handle: RunCoderHandle): void {
    handle.runner.on('plan_posted', (block: { plan: string }) => {
      if (this.master.agentRunId != null) {
        this.status.setStatus(this.master.agentRunId, 'waiting_plan');
      }
      const prompt = this.ctx.companyStore.createMasterPrompt({
        company_session_id: this.ctx.companySessionId,
        agent_run_id: this.master.agentRunId,
        kind: 'plan',
        body: block.plan,
        allow_freeform: true,
      });
      this.currentMasterPlanPromptId = prompt.id;
      this.bus.publish('master_plan_posted', { prompt });
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
      const prompt = this.ctx.companyStore.createMasterPrompt({
        company_session_id: this.ctx.companySessionId,
        agent_run_id: this.master.agentRunId,
        kind: 'question',
        runner_block_id: block.id,
        body: block.question,
        options: block.options ?? null,
        allow_freeform: block.allowFreeform !== false,
      });
      this.currentMasterQuestionPromptId = prompt.id;
      this.bus.publish('master_question_posted', { prompt });
    });
  }

  /**
   * Resolve the current master plan prompt with the human's decision.
   * `promptId` is optional: when omitted, resolves the most-recent pending
   * plan (back-compat path). Returns the resolved prompt, or null when
   * the prompt is not pending (already answered/cancelled — race with
   * shutdown) or the master runner is gone.
   */
  respondToMasterPlan(
    approved: boolean,
    feedback?: string,
    promptId?: number,
  ): MasterPrompt | null {
    const handle = this.master.handle;
    if (!handle) return null;

    const targetId = promptId
      ?? this.currentMasterPlanPromptId
      ?? this.ctx.companyStore.getPendingMasterPrompt(this.ctx.companySessionId, 'plan')?.id
      ?? null;
    if (targetId == null) return null;

    const updated = this.ctx.companyStore.resolveMasterPrompt(targetId, {
      kind: 'plan', approved, feedback,
    });
    if (!updated) return null; // Already resolved/cancelled — don't double-deliver.

    const response = JSON.stringify({ approved, feedback: feedback ?? '' });
    const delivered = handle.runner.provideUserInput(response);
    if (!delivered) {
      // Runner wasn't actually waiting (rare). Persisted state is correct;
      // just publish the resolution event for clients.
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

  respondToMasterQuestion(answer: string, promptId?: number): MasterPrompt | null {
    const handle = this.master.handle;
    if (!handle) return null;

    const targetId = promptId
      ?? this.currentMasterQuestionPromptId
      ?? this.ctx.companyStore.getPendingMasterPrompt(this.ctx.companySessionId, 'question')?.id
      ?? null;
    if (targetId == null) return null;

    const updated = this.ctx.companyStore.resolveMasterPrompt(targetId, {
      kind: 'question', answer,
    });
    if (!updated) return null;

    const response = JSON.stringify({ answer });
    handle.runner.provideUserInput(response);
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

  /**
   * Cancel every still-pending master prompt for this session and emit
   * `master_prompt_cancelled` events. Called on session abort / master end
   * so dashboards can transition cards from "pending" to "cancelled".
   */
  cancelPendingMasterPrompts(): MasterPrompt[] {
    const cancelled = this.ctx.companyStore.cancelPendingMasterPrompts(
      this.ctx.companySessionId,
    );
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

  wireSubordinatePlan(handle: RunCoderHandle, agentRunId: number, role: string): void {
    handle.runner.on('plan_posted', (block: { plan: string; toolUseId?: string }) => {
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

      // Wake the master in real time so `wait_for_subordinates` returns
      // instead of polling until the subordinate eventually completes.
      this.master.handle?.runner.interruptWait({ kind: 'plan', agentRunId, role });
      this.master.notify(
        `[SYSTEM] @${role} (agent_run_id=${agentRunId}) submitted a plan for approval and is BLOCKED.\n` +
        `Plan:\n${block.plan}\n` +
        `Use approve_subordinate_plan(agent_run_id=${agentRunId}, approved=true/false, feedback="...") to respond.`,
      );
      this.attention.signal({ kind: 'plan', agentRunId, role });
    });
  }

  wireSubordinateQuestion(handle: RunCoderHandle, agentRunId: number, role: string): void {
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

  wireSubordinateTasks(handle: RunCoderHandle, agentRunId: number, role: string): void {
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

  resolvePlan(agentRunId: number, approved: boolean, feedback?: string): boolean {
    const pending = this.pendingPlans.get(agentRunId);
    if (!pending) return false;

    pending.resolve(JSON.stringify({ approved, feedback: feedback ?? '' }));
    this.pendingPlans.delete(agentRunId);

    this.board.post('master', this.master.agentRunId, 'decision',
      `[@${pending.role}] Plan ${approved ? 'APPROVED' : 'REJECTED'}${feedback ? `: ${feedback}` : ''}`);
    return true;
  }

  resolveQuestion(agentRunId: number, answer: string): boolean {
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
    agentRunId: number,
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

  hasPendingPlan(agentRunId: number): boolean { return this.pendingPlans.has(agentRunId); }
  hasPendingQuestion(agentRunId: number): boolean { return this.pendingQuestions.has(agentRunId); }
  hasPendingTasks(agentRunId: number): boolean { return this.pendingTasks.has(agentRunId); }

  /** Clear all pending entries for a given agent (used on abort). */
  clearForAgent(agentRunId: number): void {
    this.pendingPlans.delete(agentRunId);
    this.pendingQuestions.delete(agentRunId);
    this.pendingTasks.delete(agentRunId);
  }

  /** Clear everything (used on abortAll / finalize). */
  clearAll(): void {
    this.pendingPlans.clear();
    this.pendingQuestions.clear();
    this.pendingTasks.clear();
  }
}
