/**
 * Hook Bus (Fase 2 — 2D).
 *
 * Unifies the two existing hook registries (runtime + project) behind one
 * ordered definition contract (doc 14 §12). Hooks are ordered by
 * stage → source precedence → priority → hook ID and dispatched by kind.
 *
 * Invariants:
 *   - Observation hooks NEVER participate in the PolicyDecision; a thrown
 *     observation hook is contained and cannot alter the run.
 *   - Decision hooks contribute one vote as a `hook` source; they can never
 *     reduce a higher-precedence deny (that is enforced by the Policy Engine's
 *     precedence, not here).
 *   - `inputPatch` from a decision hook is a PROPOSAL only: the caller must
 *     validate the patch, recompute the effective-input hash / resource
 *     binding, and re-run policy before any allow/approval. This bus applies
 *     the patch to a COPY and returns it plus `requiresReevaluation: true`; it
 *     never lets a patched decision become final in one pass.
 */
import type { JsonPatch, ResourceConstraint } from '@mcp/agent-runtime-contracts';

export type HookKind = 'observation' | 'decision' | 'prompt_augmentation' | 'presentation';

export type HookStage =
  | 'command_received'
  | 'run_resolving'
  | 'run_started'
  | 'user_prompt_received'
  | 'before_provider_call'
  | 'after_provider_call'
  | 'before_capability'
  | 'after_capability'
  | 'policy_decision'
  | 'agent_spawned'
  | 'agent_terminal'
  | 'before_compaction'
  | 'after_compaction'
  | 'run_terminal'
  | 'session_stopped';

export type HookSource = 'system' | 'organization' | 'project' | 'plugin';
export type HookTrustLevel = 'trusted_process' | 'isolated_worker' | 'sandboxed_remote';
export type HookFailurePolicy = 'open' | 'closed' | 'abstain';

export interface HookDefinition<Ctx = unknown> {
  hookId: string;
  version: string;
  kind: HookKind;
  stage: HookStage;
  source: HookSource;
  trustLevel: HookTrustLevel;
  timeoutMs: number;
  priority: number;
  failurePolicy: HookFailurePolicy;
  idempotency: 'none' | 'event_id';
  redactionPolicyRef: string;
  handler: (ctx: Ctx) => HookHandlerResult | Promise<HookHandlerResult>;
}

export interface DecisionHookResult {
  outcome: 'allow' | 'deny' | 'ask' | 'abstain';
  reasonCode?: string;
  inputPatch?: JsonPatch;
  constraints?: ResourceConstraint[];
}

export type HookHandlerResult = void | DecisionHookResult;

const SOURCE_PRECEDENCE: Record<HookSource, number> = {
  system: 1,
  organization: 2,
  project: 3,
  plugin: 4,
};

/** Stage → source precedence → priority → hook ID. Pure and total. */
export function orderHooks<Ctx>(hooks: readonly HookDefinition<Ctx>[]): HookDefinition<Ctx>[] {
  return [...hooks].sort((a, b) => {
    if (a.source !== b.source) return SOURCE_PRECEDENCE[a.source] - SOURCE_PRECEDENCE[b.source];
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.hookId.localeCompare(b.hookId);
  });
}

async function runWithTimeout<T>(
  fn: () => T | Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve().then(fn),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`hook timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface DecisionDispatchResult {
  votes: Array<{ hookId: string; source: HookSource; outcome: DecisionHookResult['outcome']; reasonCode?: string; constraints?: ResourceConstraint[] }>;
  /** Any proposed input patches, in order — the caller re-validates + re-runs policy. */
  proposedPatches: Array<{ hookId: string; patch: JsonPatch }>;
  requiresReevaluation: boolean;
  timeouts: number;
  errors: number;
}

export class HookBus {
  private readonly hooks = new Map<HookStage, HookDefinition<unknown>[]>();

  register<Ctx>(def: HookDefinition<Ctx>): void {
    const list = this.hooks.get(def.stage) ?? [];
    list.push(def as HookDefinition<unknown>);
    this.hooks.set(def.stage, list);
  }

  list(stage: HookStage): HookDefinition<unknown>[] {
    return orderHooks(this.hooks.get(stage) ?? []);
  }

  /**
   * Fires observation/presentation hooks for a stage. Failures are contained
   * per `failurePolicy` and NEVER propagate: a thrown observation hook cannot
   * alter the run. Returns how many timed out / errored (telemetry).
   */
  async fireObservation<Ctx>(stage: HookStage, ctx: Ctx): Promise<{ fired: number; timeouts: number; errors: number }> {
    let fired = 0;
    let timeouts = 0;
    let errors = 0;
    for (const hook of this.list(stage)) {
      if (hook.kind !== 'observation' && hook.kind !== 'presentation') continue;
      fired += 1;
      const result = await runWithTimeout(() => hook.handler(ctx), hook.timeoutMs);
      if (!result.ok) {
        if (result.error.message.includes('timed out')) timeouts += 1;
        else errors += 1;
        // Contained: observation/presentation failures never affect the run.
      }
    }
    return { fired, timeouts, errors };
  }

  /**
   * Fires decision hooks at `policy_decision`/`before_capability` stages and
   * collects their votes + proposed patches. A hook that times out or throws
   * is resolved by its `failurePolicy`: 'closed' → deny vote, 'open' → allow
   * vote, 'abstain' → abstain. A valid `inputPatch` is queued for the caller
   * (never applied as final) and sets `requiresReevaluation`.
   */
  async fireDecision<Ctx>(stage: HookStage, ctx: Ctx): Promise<DecisionDispatchResult> {
    const votes: DecisionDispatchResult['votes'] = [];
    const proposedPatches: DecisionDispatchResult['proposedPatches'] = [];
    let timeouts = 0;
    let errors = 0;

    for (const hook of this.list(stage)) {
      if (hook.kind !== 'decision') continue;
      const result = await runWithTimeout(() => hook.handler(ctx), hook.timeoutMs);
      if (!result.ok) {
        if (result.error.message.includes('timed out')) timeouts += 1;
        else errors += 1;
        const fallback: DecisionHookResult['outcome'] =
          hook.failurePolicy === 'closed' ? 'deny'
            : hook.failurePolicy === 'open' ? 'allow'
              : 'abstain';
        votes.push({ hookId: hook.hookId, source: hook.source, outcome: fallback, reasonCode: `hook_failure:${hook.failurePolicy}` });
        continue;
      }
      const decision = (result.value ?? { outcome: 'abstain' }) as DecisionHookResult;
      votes.push({
        hookId: hook.hookId,
        source: hook.source,
        outcome: decision.outcome,
        reasonCode: decision.reasonCode,
        constraints: decision.constraints,
      });
      if (decision.inputPatch && isValidJsonPatch(decision.inputPatch)) {
        proposedPatches.push({ hookId: hook.hookId, patch: decision.inputPatch });
      }
    }

    return {
      votes,
      proposedPatches,
      requiresReevaluation: proposedPatches.length > 0,
      timeouts,
      errors,
    };
  }
}

/**
 * Fresh per-run bus. Nothing registers process-wide hooks today; hosts that
 * need hooks inject a populated bus through `RunCoderOptions.hookBus`.
 */
export function createRuntimeHookBus(): HookBus {
  return new HookBus();
}

/** Structural validation of a JSON Patch proposal — invalid patches are dropped. */
export function isValidJsonPatch(patch: unknown): patch is JsonPatch {
  if (!Array.isArray(patch)) return false;
  const ops = new Set(['add', 'remove', 'replace', 'move', 'copy', 'test']);
  return patch.every((op) =>
    op && typeof op === 'object'
    && typeof (op as { op?: unknown }).op === 'string'
    && ops.has((op as { op: string }).op)
    && typeof (op as { path?: unknown }).path === 'string'
    && (op as { path: string }).path.startsWith('/'),
  );
}
