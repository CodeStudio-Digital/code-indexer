/**
 * Policy shadow composition adapter (Fase 2.5).
 *
 * Converts the five `CODER_*` flags into the `policyShadow` port consumed by
 * `dispatchTools` (executing-dispatch.ts). This is the ONLY place where the
 * Fase 2 modules (capability catalog, policy engine, hook bus, stores) are
 * wired together for production runs.
 *
 * Contract:
 *   - With every flag off, `createPolicyShadowPort` returns `null` — the port
 *     is absent and the dispatch path stays byte-identical to legacy.
 *   - Flags are re-checked PER INVOCATION: flipping the shadow flag off
 *     mid-run stops new evaluations/persistence immediately (kill switch,
 *     same posture as the Fase 1 shadow helpers).
 *   - Evaluation + persistence are best-effort: any internal error is counted
 *     and the port returns `{ refuse: false }` — the shadow can NEVER take a
 *     run down.
 *   - Only `CODER_POLICY_ENGINE_ENFORCE=1` (dormant; a human gate) lets the
 *     port refuse a call, and only when the shadow decision is not `allow`.
 */
import { randomUUID } from 'node:crypto';
import type DatabaseConstructor from 'better-sqlite3';
import {
  CapabilityStore,
  PolicyDecisionStore,
} from '@mcp/store/control-plane/index.js';
import type { CoderTool } from './tool.js';
import type { ToolRegistry } from './registry.js';
import type { PolicyContext } from './policy.js';
import {
  deriveCapabilityDescriptor,
  resolveCapabilitySet,
} from './capability-catalog.js';
import { evaluatePolicyShadow, type PolicySourceVote } from './policy-engine.js';
import type { HookBus } from './hook-bus.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export type PolicyShadowPort = (input: {
  tool: CoderTool | null;
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  turn: number;
}) => Promise<{ refuse: true; refusalText: string } | { refuse: false }>;

export interface PolicyShadowSessionContext {
  /** Legacy policy facts, read LIVE so mid-run plan/spec approval applies. */
  getLegacyContext: () => PolicyContext;
  /** True for a background (non-interactive) run — ask becomes deny. */
  background: boolean;
  sessionId?: string;
  agentRunId?: string;
  /** Late-bound for child runners whose run id is assigned in construction. */
  getAgentRunId?: () => string | undefined;
  /** Actual filtered tool surface for this scoped run. */
  capabilityRegistry?: ToolRegistry;
}

export interface PolicyShadowDeps {
  db: DB;
  registry: ToolRegistry;
  sessionContext: PolicyShadowSessionContext;
  /** Optional hook bus — consulted only when CODER_HOOK_BUS_V1=1. */
  hookBus?: HookBus | null;
  log?: (level: 'warn' | 'info', msg: string) => void;
}

export interface PolicyShadowMetrics {
  evaluations: number;
  refusals: number;
  errors: number;
}

export interface PolicyShadowComposition {
  port: PolicyShadowPort;
  metrics: PolicyShadowMetrics;
  /** Create a child-local view over the same authority/stores/hook bus. */
  createScopedPort: (sessionContext: PolicyShadowSessionContext) => PolicyShadowPort;
}

const flag = (name: string): boolean => process.env[name] === '1';
const shadowEnabled = (): boolean => flag('CODER_POLICY_ENGINE_SHADOW');
const catalogEnabled = (): boolean => flag('CODER_CAPABILITY_CATALOG_SHADOW');
const hookBusEnabled = (): boolean => flag('CODER_HOOK_BUS_V1');
const enforceEnabled = (): boolean => flag('CODER_POLICY_ENGINE_ENFORCE');
const resourceGrantsEnabled = (): boolean => flag('CODER_RESOURCE_GRANTS');
const anyFlagOn = (): boolean =>
  shadowEnabled() || catalogEnabled() || hookBusEnabled()
  || resourceGrantsEnabled() || enforceEnabled();

/**
 * Builds the production `policyShadow` port, or `null` when every flag is off
 * at composition time. The returned port re-checks the flags on every call.
 */
export function createPolicyShadowPort(
  deps: PolicyShadowDeps,
): PolicyShadowComposition | null {
  if (!anyFlagOn()) return null;

  const metrics: PolicyShadowMetrics = { evaluations: 0, refusals: 0, errors: 0 };
  const decisions = new PolicyDecisionStore(deps.db);
  const capabilities = new CapabilityStore(deps.db);
  const warn = (msg: string): void => deps.log?.('warn', `[policy-shadow] ${msg}`);

  const createScopedPort = (sessionContext: PolicyShadowSessionContext): PolicyShadowPort => {
    // Lazy, once per scoped run. Child ports share authority and persistence,
    // but record their own resolved capability-set identity.
    let capabilitySetRecorded = false;
    const recordCapabilitySetOnce = (): void => {
      if (capabilitySetRecorded || !catalogEnabled()) return;
      capabilitySetRecorded = true;
      try {
        const agentRunId = (
          sessionContext.getAgentRunId?.()
          ?? sessionContext.agentRunId
          ?? `run:${randomUUID()}`
        ) as never;
        const registry = sessionContext.capabilityRegistry ?? deps.registry;
        const { set, descriptors } = resolveCapabilitySet(registry.list(), { agentRunId });
        capabilities.recordDescriptors(descriptors, set.catalogVersion, set.resolvedAt);
        capabilities.recordResolvedSet(set);
      } catch (error) {
        metrics.errors += 1;
        warn(`capability set snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    return async (input) => {
      // Kill switch: flags re-checked per invocation.
      if (!shadowEnabled() && !enforceEnabled() && !hookBusEnabled() && !resourceGrantsEnabled()) {
        return { refuse: false };
      }
      try {
        recordCapabilitySetOnce();

        const tool = input.tool;
        if (!tool) return { refuse: false }; // unknown tool — legacy path decides

        // The persistent grant store exists, but this dispatch contract does
        // not yet carry a concrete grant id/nonce to bind and consume.
        // Enforcement must not pretend the obligation was applied.
        if (enforceEnabled() && resourceGrantsEnabled()) {
          metrics.refusals += 1;
          return {
            refuse: true,
            refusalText: '[policy-engine: unavailable — resource_grant_binding_required] Tool execution blocked by fail-closed enforcement.',
          };
        }

        const { descriptor } = deriveCapabilityDescriptor(tool);
        let extraVotes: PolicySourceVote[] | undefined;
        if (hookBusEnabled() && deps.hookBus) {
          const hookContext = {
            toolName: input.toolName,
            toolUseId: input.toolUseId,
            turn: input.turn,
            toolInput: input.toolInput,
            capabilityId: descriptor.capabilityId,
            capabilityVersion: descriptor.version,
          };
          // Match the target ordering (and ClaudeOpen's PreToolUse boundary):
          // before-capability decisions run before the final policy-decision
          // stage. Both sets become hook-source votes; neither can bypass a
          // higher-precedence deny.
          const beforeDispatch = await deps.hookBus.fireDecision('before_capability', hookContext);
          const policyDispatch = await deps.hookBus.fireDecision('policy_decision', hookContext);
          if (enforceEnabled()
            && (beforeDispatch.requiresReevaluation || policyDispatch.requiresReevaluation)) {
            metrics.refusals += 1;
            return {
              refuse: true,
              refusalText: '[policy-engine: unavailable — input_reevaluation_required] Tool execution blocked until the validated hook patch can be rebound.',
            };
          }
          extraVotes = [...beforeDispatch.votes, ...policyDispatch.votes].map((v) => ({
            sourceType: v.source === 'plugin' ? 'hook' as const : v.source,
            sourceRef: `hook:${v.hookId}`,
            outcome: v.outcome,
            reasonCode: v.reasonCode,
            constraints: v.constraints,
          }));
        }

        const startedAt = performance.now();
        const agentRunId = sessionContext.getAgentRunId?.() ?? sessionContext.agentRunId;
        const result = evaluatePolicyShadow({
          tool,
          capabilityId: descriptor.capabilityId,
          capabilityVersion: descriptor.version,
          args: input.toolInput,
          legacyContext: sessionContext.getLegacyContext(),
          background: sessionContext.background,
          extraVotes,
          toolUseId: input.toolUseId,
          sessionId: sessionContext.sessionId,
          agentRunId,
        });
        const evaluationMs = performance.now() - startedAt;
        metrics.evaluations += 1;

        // Persistence is best-effort and never blocks the invocation.
        try {
          decisions.record({
            decision: result.decision,
            sessionId: sessionContext.sessionId,
            agentRunId,
            toolUseId: input.toolUseId,
            capabilityId: descriptor.capabilityId,
            capabilityVersion: descriptor.version,
            policyVersion: result.decision.audit.policyVersion,
            background: sessionContext.background,
          });
          decisions.recordComparison({
            comparisonId: `cmp:${result.decision.decisionId}`,
            decisionId: result.decision.decisionId,
            sessionId: sessionContext.sessionId,
            capabilityId: descriptor.capabilityId,
            toolUseId: input.toolUseId,
            legacyEffect: result.comparison.legacyEffect,
            shadowEffect: result.comparison.shadowEffect,
            evaluationMs,
          });
        } catch (error) {
          metrics.errors += 1;
          warn(`persistence failed for ${input.toolName}: ${error instanceof Error ? error.message : String(error)}`);
        }

        if (enforceEnabled() && result.decision.constraints.length > 0) {
          metrics.refusals += 1;
          return {
            refuse: true,
            refusalText: '[policy-engine: unavailable — resource_binding_required] Tool execution blocked until policy constraints are sealed into an execution binding.',
          };
        }

        // Dormant enforcement — only a human-flipped flag reaches this.
        if (enforceEnabled() && result.decision.effect !== 'allow') {
          metrics.refusals += 1;
          return {
            refuse: true,
            refusalText: `[policy-engine: ${result.decision.effect} — ${result.decision.reasonCode}] ${result.decision.explanation ?? ''}`.trim(),
          };
        }
        return { refuse: false };
      } catch (error) {
        metrics.errors += 1;
        warn(`evaluation failed for ${input.toolName}: ${error instanceof Error ? error.message : String(error)}`);
        if (enforceEnabled()) {
          metrics.refusals += 1;
          return {
            refuse: true,
            refusalText: '[policy-engine: unavailable — evaluation_error] Tool execution blocked by fail-closed enforcement.',
          };
        }
        return { refuse: false };
      }
    };
  };

  return {
    port: createScopedPort(deps.sessionContext),
    metrics,
    createScopedPort,
  };
}
