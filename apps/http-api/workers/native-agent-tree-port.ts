import { createHash, randomUUID } from 'node:crypto';
import { toBinary } from '@bufbuild/protobuf';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { createNativeConversationMaterial } from '@mcp/agent-runtime-host';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { isUncertainToolOutcomeError } from '@mcp/code-agent/core/uncertain-tool-outcome.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import { ok, type ToolResult } from '@mcp/code-agent/core/tool.js';
import type { AgentTreeMessageRequest } from '@mcp/code-agent/ports/agent-tree-port.js';
import type { AgentTreePort, AgentTreeEvent } from '@mcp/code-agent/ports/agent-tree-port.js';
import type { PreparedCoderInputs } from '@mcp/code-agent/runtime/prepared-coder-execution.js';
import { prepareCoderAttempt } from '@mcp/code-agent/runtime/attempt-preparation.js';
import { createNativeDocumentReader } from '@mcp/code-agent/runtime/native-document-reader.js';
import { nativeProviderSelection } from '@mcp/code-agent/runtime/native-provider-binding.js';
import { wrapToolForPathScope, type SubagentParent, type SubagentSpec, type SubagentRunResult } from '@mcp/code-agent/tools/implement-subagent.js';
import { SubagentCollector } from '@mcp/code-agent/tools/subagent-collector.js';
import { NativeChildMemo } from './native-child-memo.js';
import { appendResearchContract } from '@mcp/code-agent/tools/subagent-research-policy.js';
import type { NativeCoderTreeOwner } from './native-coder-tree.js';
import { nativeChildTranscriptRef } from '../native-child-storage.js';
import { nativeCoderWorkspaceAccess } from './native-coder-catalog.js';
import { resolveRuntimePolicyV1 } from '../../../packages/agent-runtime-host/src/runtime-policy/RuntimePolicyResolver.js';

/** Captured before the root executor binds any attempt-owned ports. Children
 * never copy the invocation context containing the parent's live lease. */
export function snapshotNativeChildContext(context: ToolContext): ToolContext {
  const copy = { ...context, ports: { fs: context.ports?.fs } };
  for (const key of ['runner', 'signal', 'mutationFence', 'permissionGate', 'toolOutputStore', 'taskRuntime',
    'currentToolInvocation', 'parentToolUseId', 'externalMcpAuthority', 'previewAuthority', 'browserAuthority',
    'assertExternalMcpDispatch', 'nestedToolObserver', 'nestedCapabilityDispatch', 'workspaceRuntimeScope',
    'onDiagramChanged', 'reportProgress', 'reportHeartbeat', 'subagentCollector', 'completeInlineTaskRun'] as const) delete copy[key];
  return copy;
}

export class NativeAgentTreePort implements AgentTreePort {
  readonly runtimeGeneration = 'rust_v1' as const;
  readonly ownerAgentRunId: string;
  constructor(private readonly owner: NativeCoderTreeOwner, private readonly prepared: PreparedCoderInputs,
    private readonly baseContext: ToolContext, private readonly authorityDeadline: number,
    private readonly effectivePlanning?: () => { planMode: boolean; specMode: boolean },
    private readonly decorateTool?: (tool: CoderTool) => CoderTool) {
    this.ownerAgentRunId = prepared.preparation.agentRunId;
  }

  async list(options: { signal?: AbortSignal }) { return this.owner.list(options); }
  async wait(options: { targets: string[]; timeoutMs: number; signal?: AbortSignal }) { return this.owner.wait(options); }
  async message(input: AgentTreeMessageRequest) { return this.owner.message(input); }
  async collect(options: { jobId?: string; timeoutMs: number; signal?: AbortSignal }) { return this.owner.collect(options); }
  async background(input: { invocationId: string; task: unknown; signal?: AbortSignal }, run: (signal: AbortSignal) => Promise<ToolResult>) {
    return this.owner.background(input, run);
  }

  async run(parent: SubagentParent, spec: SubagentSpec): Promise<SubagentRunResult> {
    if (parent.ctx.runtimeGeneration !== 'rust_v1' || parent.ctx.controlPlaneParentAgentRunId !== this.ownerAgentRunId
      || parent.sessionId && parent.sessionId !== this.prepared.preparation.sessionId) throw new Error('Native child has a foreign parent');
    spec.signal?.throwIfAborted(); parent.ctx.signal?.throwIfAborted();
    if (this.prepared.preparation.policy.runtime?.subagents.enabled === false) throw new Error('Native subagents are disabled by policy');
    const signal = AbortSignal.any([spec.signal, parent.ctx.signal].filter((value): value is AbortSignal => !!value));
    const provider = spec.provider ?? parent.provider;
    const selection = provider === this.prepared.provider ? this.prepared.preparation : nativeProviderSelection(provider);
    if (!selection) throw new Error('Native child provider lacks its configured product selection');
    const systemPrompt = appendResearchContract(spec.systemPrompt, spec.researchPolicy);
    const collector = new SubagentCollector(), memo = new NativeChildMemo(collector);
    const registry = new ToolRegistry(), sandboxViolations: string[] = [];
    const requested = new Set(parent.tools.map(tool => tool.name));
    for (const tool of this.prepared.registry.list()) {
      if (tool.name === 'record_memo') continue;
      if (!requested.has(tool.name) || spec.allowlist !== null && (typeof spec.allowlist === 'function'
        ? !spec.allowlist(tool) : !spec.allowlist.has(tool.name))) continue;
      const scoped = spec.pathScope?.length ? wrapToolForPathScope(tool, [...spec.pathScope], sandboxViolations, spec.pathScopeMode) : tool;
      registry.register(this.decorateTool ? this.decorateTool(scoped) : scoped);
    }
    // This child-local collector capability is also present on legacy children.
    // It has no workspace or application authority and is sealed before launch.
    registry.register(memo.tool);
    registry.seal();
    const maxTurns = boundedLimit(spec.maxTurns, this.prepared.maxTurns || undefined);
    const inherited = this.prepared.preparation.policy.runtime?.execution;
    const maxToolCalls = boundedLimit(spec.limits?.maxToolCalls, inherited?.maxToolCalls);
    const timeout = boundedLimit(spec.limits?.timeoutMs, inherited?.maxWallMs);
    const deadlineAtUnixMs = Math.min(this.authorityDeadline, this.owner.shared.budget.limits.deadlineAtUnixMs,
      timeout === undefined ? Number.MAX_SAFE_INTEGER : Date.now() + timeout + 1000);
    if (deadlineAtUnixMs <= Date.now() + 1000) throw new Error('Native child has no remaining execution budget');
    const messages = await snapshotMessages(spec, this.baseContext, signal);
    if (spec.nativeResumeRef) {
      const guidance = messages[0];
      if (messages.length !== 1 || guidance?.role !== 'user' || guidance.content.length !== 1
        || guidance.content[0]?.type !== 'text' || !guidance.content[0].text.trim()
        || Buffer.byteLength(guidance.content[0].text) > 64 * 1024) throw new Error('Native child resume requires bounded explicit guidance');
    }
    const material = await createNativeConversationMaterial({ sessionId: this.prepared.preparation.sessionId,
      messages, maximumBytes: 8 * 1024 * 1024, signal });
    let taskSha256: string;
    try { taskSha256 = createHash('sha256').update(toBinary(agentV1Runtime.TaskInputSchema, material.task)).digest('hex'); }
    finally { material.close(); }
    let toolCallCount = 0;
    const started = Date.now();
    const queuedSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(2_147_483_647, deadlineAtUnixMs - Date.now() - 1000)))]);
    const release = await this.owner.scheduler.acquire(nativeCoderWorkspaceAccess(registry.list(), true), queuedSignal);
    let result: Awaited<ReturnType<NativeCoderTreeOwner['runPrepared']>>;
    try { result = await this.owner.runPrepared({ idempotencyKey: `spawn:${spec.spawnId ?? randomUUID()}`, role: 'subagent',
      agentDefinitionId: spec.profile ?? this.prepared.preparation.agentDefinitionId, taskSha256,
      ...(spec.nativeResumeRef ? { resumeFromRef: spec.nativeResumeRef } : {}),
      ...(spec.nativeFollowup ? { continuationPurpose: 'followup' as const } : {}),
      provider: selection.provider, model: selection.model, deadlineAtUnixMs }, async (admission, childSignal) => {
      await spec.onNativeAdmission?.(nativeChildTranscriptRef(admission.context, this.owner.shared.root.attemptId));
      childSignal.throwIfAborted();
      const policy = structuredClone(this.prepared.preparation.policy);
      // Approvals are owned by the live parent interaction port. A child
      // seals the resulting policy at admission; it never copies stale plan
      // gates from the parent's original preparation or accepts model flags.
      if (this.effectivePlanning) Object.assign(policy, this.effectivePlanning());
      const baseRuntime = policy.runtime ?? resolveRuntimePolicyV1();
      const { schemaVersion, policyId, policyDigest, resolvedAt, provenance, ...values } = baseRuntime;
      policy.runtime = resolveRuntimePolicyV1({ operator: { revision: policyDigest, values },
        request: { revision: `native-child:${admission.context.attemptId}`, values: { execution: {
          maxTurns: maxTurns ?? null, maxToolCalls: maxToolCalls ?? null, maxWallMs: timeout ?? null } } } });
      const preparation = prepareCoderAttempt({ ...this.prepared.preparation, agentRunId: admission.context.agentRunId,
        runnerRunId: randomUUID(), provider: selection.provider, model: selection.model,
        reasoningEffort: spec.reasoningEffort ?? this.prepared.preparation.reasoningEffort,
        agentDefinitionId: spec.profile ?? this.prepared.preparation.agentDefinitionId,
        systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'), policy }, registry);
      return { preparation, registry, provider, systemPrompt, messages, thinking: this.prepared.thinking,
        thinkingBudgetTokens: this.prepared.thinkingBudgetTokens, maxTurns: maxTurns ?? 0, signal: childSignal,
        toolContext: { ...snapshotNativeChildContext(this.baseContext), runtimeGeneration: 'rust_v1',
          sessionId: admission.context.sessionId, controlPlaneParentAgentRunId: admission.context.agentRunId,
          signal: childSignal, subagentCollector: collector } };
    }, event => {
      memo.accept(event);
      if (event.event === 'tool_call_start') {
        toolCallCount++;
        spec.onProgress?.({ event: 'tool_call', toolCallCount,
          toolName: (event.data as { name?: string }).name, elapsedMs: Date.now() - started });
      } else if (event.event === 'heartbeat') spec.onProgress?.({ event: 'heartbeat', toolCallCount, elapsedMs: Date.now() - started });
    }, signal); } catch (cause) {
      if (!isUncertainToolOutcomeError(cause)) throw cause;
      return { reason: 'error', finalText: cause.message, failureDetail: cause.message, effectOutcome: 'unknown',
        usage: { input_tokens: 0, output_tokens: 0 }, sandboxViolations, collected: collector.snapshot() };
    } finally { release(); }
    const reason: SubagentRunResult['reason'] = result.outcome.effectOutcome === 'unknown' ? 'error'
      : result.outcome.reason === 'max_tool_calls' ? 'tool_budget'
      : result.outcome.reason === 'completed' || result.outcome.reason === 'max_turns' || result.outcome.reason === 'aborted'
        ? result.outcome.reason : 'error';
    if (reason === 'completed' || reason === 'max_turns' || reason === 'tool_budget') {
      this.owner.registerContinuation?.(result.admission.context.agentRunId, async (text, childSignal, invocationId) => {
        const next = await this.run({ ...parent, ctx: { ...parent.ctx, signal: childSignal } }, {
          ...spec, signal: childSignal, nativeResumeRef: result.transcriptRef, nativeFollowup: true, spawnId: `followup-${invocationId}`,
          onNativeAdmission: undefined, initialMessages: [{ role: 'user', content: [{ type: 'text', text }] }],
        });
        return { ...ok(next.finalText), isError: next.reason !== 'completed', effectOutcome: next.effectOutcome,
          subUsage: next.usage, structuredData: { reason: next.reason, nativeTranscriptRef: next.nativeTranscriptRef } };
      });
    }
    return { reason, finalText: result.finalText, usage: result.outcome.usage, sandboxViolations,
      collected: collector.snapshot(), nativeTranscriptRef: result.transcriptRef, effectOutcome: result.outcome.effectOutcome,
      ...(reason === 'error' ? { failureDetail: result.outcome.error ?? result.outcome.reason } : {}) };
  }

  emit(event: AgentTreeEvent, data: unknown): void { this.owner.emit(event, data); }
  reconcile(reference: string, options: { signal?: AbortSignal }) { return this.owner.reconcile(reference, options); }
  readTranscript(reference: string, options: { maxChars?: number; signal?: AbortSignal }) { return this.owner.readTranscript(reference, options); }
}

function boundedLimit(requested: number | null | undefined, inherited: number | null | undefined): number | undefined {
  for (const value of [requested, inherited]) if (value != null && (!Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid native child execution limit');
  const values = [requested, inherited].filter((value): value is number => value != null && value > 0);
  return values.length ? Math.min(...values) : undefined;
}

async function snapshotMessages(spec: SubagentSpec, context: ToolContext, signal: AbortSignal) {
  const messages = structuredClone(spec.initialMessages);
  const read = createNativeDocumentReader({ cwd: context.cwd, projectName: context.projectName, projectId: context.projectId,
    globalWorkspace: context.globalWorkspace, externalRoots: context.externalRoots }, 8 * 1024 * 1024);
  let bytes = 0;
  for (const message of messages) for (const block of message.content) {
    signal.throwIfAborted();
    if (block.type === 'document' && block.text === undefined && block.base64 === undefined) {
      const content = await read(block, signal); bytes += content.byteLength;
      if (bytes > 8 * 1024 * 1024) throw new Error('Native child documents exceed preparation budget');
      block.base64 = Buffer.from(content).toString('base64'); delete block.path;
    }
  }
  return messages;
}
