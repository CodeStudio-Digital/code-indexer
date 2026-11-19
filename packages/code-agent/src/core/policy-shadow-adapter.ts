/**
 * Policy shadow composition adapter (Fase 2.5).
 *
 * Composes the attempt-scoped `policyShadow` port consumed by `dispatchTools`
 * (executing-dispatch.ts). This is the ONLY place where the
 * Fase 2 modules (capability catalog, policy engine, hook bus and the injected
 * host persistence port) are wired together for production runs.
 *
 * Contract:
 *   - Comparison diagnostics are opt-in. The production dispatcher still
 *     applies its real permission, scope and recovery gates independently.
 *   - The mode is captured once at attempt composition; process env can never
 *     change authority halfway through an invocation sequence.
 *   - Evaluation + persistence are best-effort: any internal error is counted
 *     and the port returns `{ refuse: false }` — the shadow can NEVER take a
 *     run down.
 *   - Enforcement remains dormant until the typed composition layer supplies
 *     it after the P3 corpus gate.
 */
import {
  asAgentRunId,
  isUuid,
  newAgentRunId,
  type AgentRunId,
  type SessionId,
} from '@mcp/session-storage';
import type { CoderTool } from './tool.js';
import type { ToolRegistry } from './registry.js';
import type { PolicyContext } from './policy.js';
import {
  deriveCapabilityDescriptor,
  resolveCapabilitySet,
} from './capability-catalog.js';
import { evaluatePolicyShadow, type PolicySourceVote } from './policy-engine.js';
import type { HookBus } from './hook-bus.js';
import type { PolicyShadowPersistencePort } from './policy-shadow-persistence.js';

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
  sessionId: SessionId;
  agentRunId?: AgentRunId | string;
  /** Late-bound for child runners whose run id is assigned in construction. */
  getAgentRunId?: () => AgentRunId | string | undefined;
  /** Actual filtered tool surface for this scoped run. */
  capabilityRegistry?: ToolRegistry;
}

export interface PolicyShadowDeps {
  persistence: PolicyShadowPersistencePort;
  registry: ToolRegistry;
  sessionContext: PolicyShadowSessionContext;
  /** Optional hook bus used whenever the policy shadow itself is active. */
  hookBus?: HookBus | null;
  catalogOnlyCapabilities?: readonly CoderTool[];
  /** Internal attempt-scoped mode. Production callers use the safe defaults. */
  mode?: Partial<PolicyShadowMode>;
  log?: (level: 'warn' | 'info', msg: string) => void;
}

export interface PolicyShadowMode {
  shadow: boolean;
  catalog: boolean;
  enforce: boolean;
  resourceGrants: boolean;
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

const DEFAULT_MODE: Readonly<PolicyShadowMode> = Object.freeze({
  // This observer cannot authorize or refuse a call. Persisting a decision
  // and comparison before EVERY tool adds synchronous durability barriers to
  // ordinary reads and edits. Keep the diagnostic available for explicit
  // burn-in; do not put it on the production execution path by default.
  shadow: false,
  catalog: true,
  enforce: false,
  resourceGrants: false,
});

/**
 * Builds the production `policyShadow` port. Mode is immutable for the attempt.
 */
export function createPolicyShadowPort(
  deps: PolicyShadowDeps,
): PolicyShadowComposition | null {
  const mode: Readonly<PolicyShadowMode> = Object.freeze({
    ...DEFAULT_MODE,
    ...deps.mode,
  });
  if (!mode.shadow && !mode.enforce && !mode.resourceGrants) return null;
  const shadowEnabled = (): boolean => mode.shadow;
  const catalogEnabled = (): boolean => mode.catalog;
  const enforceEnabled = (): boolean => mode.enforce;
  const resourceGrantsEnabled = (): boolean => mode.resourceGrants;
  const metrics: PolicyShadowMetrics = { evaluations: 0, refusals: 0, errors: 0 };
  const warn = (msg: string): void => deps.log?.('warn', `[policy-shadow] ${msg}`);

  const createScopedPort = (sessionContext: PolicyShadowSessionContext): PolicyShadowPort => {
    // Lazy, once per scoped run. Child ports share authority and persistence,
    // but record their own resolved capability-set identity.
    let capabilitySetRecorded = false;
    let capabilitySetRecording: Promise<void> | null = null;
    const generatedAgentRunId = newAgentRunId();
    const resolveAgentRunId = (): AgentRunId => {
      const candidate =
        sessionContext.getAgentRunId?.() ?? sessionContext.agentRunId;
      return candidate && isUuid(candidate)
        ? asAgentRunId(candidate)
        : generatedAgentRunId;
    };
    const recordCapabilitySetOnce = async (): Promise<void> => {
      if (capabilitySetRecorded || !catalogEnabled()) return;
      if (!capabilitySetRecording) {
        capabilitySetRecording = (async () => {
          try {
            const agentRunId = resolveAgentRunId();
            const registry =
              sessionContext.capabilityRegistry ?? deps.registry;
            const { set, descriptors } = resolveCapabilitySet(
              [...registry.list(), ...(deps.catalogOnlyCapabilities ?? [])],
              { agentRunId },
            );
            await deps.persistence.recordCapabilitySet({
              sessionId: sessionContext.sessionId,
              agentRunId,
              set,
              descriptors,
            });
            capabilitySetRecorded = true;
          } catch (error) {
            metrics.errors += 1;
            warn(`capability set snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
          } finally {
            capabilitySetRecording = null;
          }
        })();
      }
      await capabilitySetRecording;
    };

    return async (input) => {
      if (!shadowEnabled() && !enforceEnabled() && !resourceGrantsEnabled()) {
        return { refuse: false };
      }
      try {
        await recordCapabilitySetOnce();

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
        if (deps.hookBus) {
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
        const agentRunId = resolveAgentRunId();
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

        // Persistence is awaited for durability, but a write failure never
        // changes the shadow decision or triggers a compatibility write.
        try {
          await deps.persistence.recordDecision({
            decision: result.decision,
            sessionId: sessionContext.sessionId,
            agentRunId,
            toolUseId: input.toolUseId,
            capabilityId: descriptor.capabilityId,
            capabilityVersion: descriptor.version,
            policyVersion: result.decision.audit.policyVersion,
            background: sessionContext.background,
          });
          await deps.persistence.recordComparison({
            comparisonId: `comparison:${result.decision.decisionId}`,
            decisionId: result.decision.decisionId,
            sessionId: sessionContext.sessionId,
            agentRunId,
            capabilityId: descriptor.capabilityId,
            toolUseId: input.toolUseId,
            legacyEffect: result.comparison.legacyEffect,
            shadowEffect: result.comparison.shadowEffect,
            comparedAt:
              result.decision.audit.decidedAt ?? new Date().toISOString(),
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
