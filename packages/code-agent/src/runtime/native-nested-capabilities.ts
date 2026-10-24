import { createHash, randomUUID } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { agentV1Capability as wire, type ResolvedCapabilitySet } from '@mcp/agent-runtime-contracts';
import { nativeToolUseId, type CapabilityDecisionResolver, type ValidatedCapabilityPrepare } from '@mcp/agent-runtime-host';
import { NATIVE_TASK_MUTATION_TOOLS } from '@mcp/session-storage/native-task-projection.js';
import { deriveCapabilityDescriptor } from '../core/capability-catalog.js';
import { err, unknownToolOutcome, type NestedCapabilityDispatch, type ToolContext } from '../core/tool.js';
import type { ToolRegistry } from '../core/registry.js';
import type { HostEffectScope } from './host-effect-scope.js';

/** Shared by direct calls and scripts for one attempt; retries cannot reset it. */
export interface NativeToolCallBudget { take(): boolean }
export class NativeInvocationBudget {
  private calls = 0;
  constructor(private readonly maximum?: number) {
    if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 1)) throw new Error('Invalid native invocation budget');
  }
  take(): boolean {
    if (this.maximum !== undefined && this.calls >= this.maximum) return false;
    this.calls++; return true;
  }
}

/** The durable parent dispatch covers the complete script. A crash/unknown
 * child effect leaves that parent unresolved, so recovery cannot replay it.
 * Child grants remain owned until the parent's durable terminal ACK. */
export class NativeNestedCapabilities {
  private readonly visible = new Set<string>();
  private readonly invocable = new Set<string>();
  private readonly receipts = new Map<string, { retired: boolean;
    children: { request: ValidatedCapabilityPrepare; grant: wire.SealedExecutionGrant }[] }>();
  constructor(private readonly options: {
    registry: ToolRegistry;
    capabilitySet: ResolvedCapabilitySet;
    resolver: CapabilityDecisionResolver;
    validateGrant: (request: ValidatedCapabilityPrepare, grant: wire.SealedExecutionGrant) => Promise<void>;
    effects: HostEffectScope;
    budget: NativeToolCallBudget;
    now: () => bigint;
  }) {
    if (!options.registry.isSealed) throw new Error('Native nested tools require a sealed registry');
    for (const tool of options.registry.list()) {
      const id = deriveCapabilityDescriptor(tool).descriptor.capabilityId;
      if (!options.capabilitySet.visible.includes(id) || !options.capabilitySet.eligible.includes(id)) continue;
      this.visible.add(tool.name);
      // These private projections currently commit against a direct result's
      // identity. They must never be staged and silently lost inside a script.
      if (!NATIVE_TASK_MUTATION_TOOLS.includes(tool.name) && !['create_goal', 'update_goal', 'code_exec', 'workflow'].includes(tool.name)) {
        this.invocable.add(tool.name);
      }
    }
  }
  bind(parent: ValidatedCapabilityPrepare): NestedCapabilityDispatch {
    if (this.receipts.has(parent.operationId)) throw new Error('Nested parent was already dispatched');
    const receipts: { retired: boolean; children: { request: ValidatedCapabilityPrepare; grant: wire.SealedExecutionGrant }[] } = {
      retired: false, children: [],
    };
    this.receipts.set(parent.operationId, receipts);
    return { turn: 0, visibleToolNames: this.visible, invocableToolNames: this.invocable,
      invoke: (name, args, context, dispatched) => this.options.effects.track(async () => {
        const check = () => {
          context.signal?.throwIfAborted();
          if (this.receipts.get(parent.operationId) !== receipts) throw new Error('Nested parent authority retired');
          if (this.options.now() >= parent.deadlineAtUnixMs) throw new Error('Nested parent deadline elapsed');
        };
        check();
        if (context.toolCallLedger?.outcomeUnknownTool) return unknownToolOutcome('A previous nested effect is unresolved');
        if (!this.invocable.has(name)) return err('Nested capability is not in the admitted snapshot');
        if (!this.options.budget.take()) return err('Native attempt reached max_tool_calls (including nested calls)');
        const tool = this.options.registry.get(name)!;
        const descriptor = deriveCapabilityDescriptor(tool).descriptor;
        const encodedJsonInput = Buffer.from(JSON.stringify(args));
        if (encodedJsonInput.byteLength > 1024 * 1024) return err('Nested capability input exceeds 1 MiB');
        const id = randomUUID();
        const request: ValidatedCapabilityPrepare = { ...parent, operationId: `nested:${id}`, toolUseId: `nested:${id}`,
          idempotencyKey: `nested:${id}`, capabilityId: descriptor.capabilityId, capabilityVersion: descriptor.version,
          mutates: descriptor.execution.mutates, encodedJsonInput,
          inputSha256: createHash('sha256').update(encodedJsonInput).digest() };
        const decision = await this.options.resolver.resolve(request);
        if (decision.case !== 'accepted') return err(decision.case === 'rejected'
          ? `Nested capability denied: ${decision.value.reasonCode}` : 'Nested capability approval was not resolved');
        const receipt = { request, grant: decision.value };
        if (receipts.retired) this.retireChild(receipt);
        else receipts.children.push(receipt);
        check(); await this.options.validateGrant(request, decision.value); check();
        const child: ToolContext = { ...context, nestedCapabilityDispatch: undefined,
          currentToolUseId: nativeToolUseId(parent.identity.attemptId, parent.providerOperationId, request.toolUseId) };
        dispatched();
        return this.options.registry.invoke(name, JSON.parse(encodedJsonInput.toString('utf8')), child);
      }),
    };
  }
  retire(parent: ValidatedCapabilityPrepare): void {
    const receipts = this.receipts.get(parent.operationId);
    this.receipts.delete(parent.operationId);
    if (!receipts) return;
    receipts.retired = true;
    for (const receipt of receipts.children) this.retireChild(receipt);
    receipts.children.length = 0;
  }
  private retireChild(receipt: { request: ValidatedCapabilityPrepare; grant: wire.SealedExecutionGrant }): void {
    this.options.resolver.retire?.(receipt.request,
      create(wire.CapabilityUpdateSchema, { identity: receipt.request.identity,
        runtimeInstanceId: receipt.request.runtimeInstanceId, operationId: receipt.request.operationId,
        toolUseId: receipt.request.toolUseId, decision: { case: 'accepted', value: receipt.grant } }));
  }
}
