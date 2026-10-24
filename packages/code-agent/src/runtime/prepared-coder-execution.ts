import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { asAgentRunId, type CoderAttemptPreparationV1, type agentV1Runtime } from '@mcp/agent-runtime-contracts';
import type { AgentMessage, ChatUsage } from '../core/messages.js';
import type { ToolRegistry } from '../core/registry.js';
import type { CoderTool, ToolContext } from '../core/tool.js';
import { attachmentsToBlocks } from '../core/messages.js';
import { formatIdeContext } from '../core/ide-context.js';
import type { ChatProvider } from '../providers/adapter.js';
import type { FsCoderSession } from '../sessions/fs-store/index.js';
import type { IndexStatus, RunCoderOptions } from '../index/types.js';
import type { CancelReason, InteractionResponse } from '@mcp/agent-runtime-host';
import { prepareCoderAttempt } from './attempt-preparation.js';
import type { NativeBoundaryRecall } from './native-boundary-context.js';
import { unresolvedToolOutcome, uncertainToolOutcomeError } from '../core/uncertain-tool-outcome.js';

export interface PreparedCoderInputs {
  readonly preparation: CoderAttemptPreparationV1;
  readonly registry: ToolRegistry;
  readonly toolContext: ToolContext;
  readonly provider: ChatProvider;
  readonly systemPrompt: string;
  readonly messages: readonly AgentMessage[];
  readonly preparedUserContext?: agentV1Runtime.ProviderPreparedUserContextV1;
  readonly thinking: boolean;
  readonly thinkingBudgetTokens?: number;
  readonly maxTurns: number;
  readonly resume?: boolean;
  readonly signal?: AbortSignal;
  readonly boundaryRecall?: NativeBoundaryRecall;
}

export interface PreparedCoderOutcome { reason: string; usage: ChatUsage; error?: string; effectOutcome?: 'unknown' }

export interface PreparedCoderExecution {
  readonly done: Promise<PreparedCoderOutcome>;
  /** Settles only after native transcript and projections are durable. */
  readonly transcriptFlushed: Promise<PreparedCoderOutcome>;
  isWaitingForInput?(): boolean;
  isInteractionPending?(askId: string): boolean;
  cancel(reason?: CancelReason): Promise<void>;
  provideInput(askId: string, value: string): Promise<boolean>;
  resolveInteraction(askId: string, response: InteractionResponse): Promise<void>;
}

export interface PreparedCoderHandle extends PreparedCoderExecution {
  readonly runtimeGeneration: 'rust_v1';
  readonly session: FsCoderSession;
  readonly indexStatus: IndexStatus;
}

export type PreparedCoderExecutor = (input: PreparedCoderInputs) => Promise<PreparedCoderExecution>;

/** Handoff at the sealed configuration boundary, before constructing a legacy
 * runner. The caller owns admission, transcript and execution from this point. */
export async function startPreparedCoderExecution(input: {
  opts: RunCoderOptions;
  session: FsCoderSession;
  indexStatus: IndexStatus;
  registry: ToolRegistry;
  catalogOnlyCapabilities: readonly CoderTool[];
  toolContext: ToolContext;
  provider: ChatProvider;
  systemPrompt: string;
  initialMessages: readonly AgentMessage[];
  reasoningEffort?: string;
  agentDefinitionId: string;
  effectiveAgentId: string | null;
  capabilityProfile: string;
  permissionMode: string;
  thinking: boolean;
  executor: PreparedCoderExecutor;
  prepareUserContext?(messages: readonly AgentMessage[]): agentV1Runtime.ProviderPreparedUserContextV1 | undefined;
  boundaryRecall?: NativeBoundaryRecall;
  cleanup(): Promise<void>;
}): Promise<PreparedCoderHandle> {
  let handedOff = false;
  try {
    const { opts, session } = input;
    if (!opts.controlPlaneParentAgentRunId || opts.admitAttempt) {
      throw new Error('Native preparation requires a product owner and cannot admit a legacy attempt');
    }
    // These surfaces require their own certified native preparation; never
    // silently downgrade an already selected runtime to the legacy runner.
    if (opts.companyContext || opts.sandbox) {
      throw new Error('Native development preparation does not yet support this execution surface');
    }
    if ((opts.worktree && !session.worktree_path)
      || (session.worktree_path && resolve(session.worktree_path) !== resolve(input.toolContext.cwd))) {
      throw new Error('Native worktree was not prepared before sealing its context');
    }
    opts.signal?.throwIfAborted();
    const uncertain = unresolvedToolOutcome(input.initialMessages);
    if (uncertain) throw uncertainToolOutcomeError(uncertain);
    const preparation = prepareCoderAttempt({ sessionId: session.id,
      agentRunId: asAgentRunId(opts.controlPlaneParentAgentRunId), runnerRunId: randomUUID(),
      provider: session.provider, model: session.model, reasoningEffort: input.reasoningEffort,
      agentDefinitionId: input.agentDefinitionId,
      systemPromptSha256: createHash('sha256').update(input.systemPrompt).digest('hex'),
      capabilityProfile: input.capabilityProfile,
      environment: { kind: session.worktree_path ? 'worktree' : 'host', cwd: input.toolContext.cwd },
      policy: { permissionMode: input.permissionMode, planMode: !!opts.planMode,
        specMode: opts.specMode ?? (input.effectiveAgentId === 'spec'), runtime: opts.runtimePolicy },
    }, input.registry, input.catalogOnlyCapabilities);
    const ideBlock = formatIdeContext(opts.ideContext);
    const text = ideBlock ? `${ideBlock}\n\n${opts.userMessage}` : opts.userMessage;
    const messages: AgentMessage[] = opts.resume ? [...input.initialMessages] : [...input.initialMessages,
      { role: 'user', content: attachmentsToBlocks(text, opts.attachments),
        ...(opts.selectedSkillIds?.length ? { selectedSkillIds: [...opts.selectedSkillIds] } : {}) }];
    input.toolContext.runtimeGeneration = 'rust_v1';
    const execution = await input.executor({ preparation, registry: input.registry,
      toolContext: input.toolContext, provider: input.provider, systemPrompt: input.systemPrompt,
      messages, preparedUserContext: opts.resume ? undefined : input.prepareUserContext?.(messages),
      thinking: input.thinking, thinkingBudgetTokens: opts.thinkingBudgetTokens,
      maxTurns: opts.maxTurns ?? session.max_turns ?? 0, resume: !!opts.resume, signal: opts.signal,
      boundaryRecall: input.boundaryRecall });
    const done = execution.done.finally(input.cleanup);
    void done.catch(() => undefined);
    void execution.transcriptFlushed.catch(() => undefined);
    handedOff = true;
    return { runtimeGeneration: 'rust_v1', session, indexStatus: input.indexStatus,
      done, transcriptFlushed: execution.transcriptFlushed,
      isWaitingForInput: () => execution.isWaitingForInput?.() ?? false,
      isInteractionPending: id => execution.isInteractionPending?.(id) ?? false,
      cancel: (reason) => execution.cancel(reason), provideInput: (id, value) => execution.provideInput(id, value),
      resolveInteraction: (id, response) => execution.resolveInteraction(id, response) };
  } finally {
    if (!handedOff) await input.cleanup();
  }
}
