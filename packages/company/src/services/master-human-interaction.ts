import { randomUUID } from 'node:crypto';
import type { RunCoderHandle } from '@mcp/code-agent/index/types.js';
import { hashControlPlanePayload } from '@mcp/store/control-plane/index.js';
import type { IAgentStatusUpdater, IBoardPoster, IMasterNotifier, IMetaBusPublisher } from '@mcp/company/services/ports.js';

import type { SessionContext } from '@mcp/company/services/SessionContext.js';

import type { MasterPrompt } from '@mcp/company/types.js';

export class MasterHumanInteraction {
  constructor(private readonly bus: IMetaBusPublisher, private readonly board: IBoardPoster, private readonly status: IAgentStatusUpdater, private readonly master: IMasterNotifier, private readonly ctx: SessionContext) {}

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
}
