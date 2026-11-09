import { createHash } from 'node:crypto';
import { stableArgsKey } from './runner/dup-utils.js';
import type { ToolContext, ToolResult } from './tool.js';

export interface ToolOutcomeTerminalReceipt {
  readonly version: 1;
  readonly toolUseId: string;
  readonly parentToolUseId?: string;
  readonly invocationId: string;
  readonly toolName: string;
  /** Hash of normalized inputs captured before a handler may modify them. */
  readonly inputHash: string;
  readonly outcome: 'confirmed' | 'not_applied';
  readonly completedAt: string;
  readonly source: 'registry' | 'code_exec_aggregate';
}

export function toolOutcomeInputHash(input: Record<string, unknown>): string {
  return createHash('sha256').update(stableArgsKey(input)).digest('hex');
}

type KnownOutcome = ToolOutcomeTerminalReceipt['outcome'];

/**
 * An invocation owns its RAW descendants, independently of timeout races and
 * the attempt's sticky guard. No result text, args or global history is kept.
 * A wrapper receipt cannot precede a child's physical completion. Unknown
 * children poison only this aggregate; they never become successes by text.
 */
export class ToolOutcomeScope {
  private readonly pendingChildren = new Set<ToolOutcomeScope>();
  private unknownChild = false;
  private unknownChildEffects = false;
  private confirmedChild = false;
  private handlerSettled = false;
  private dispatched = false;
  private ownOutcome?: KnownOutcome;
  private evaluatorClosed = false;
  private awaitEvaluator = false;
  private completed = false;
  private readonly parentSettled?: (outcome?: KnownOutcome) => void;
  private readonly identity?: Omit<ToolOutcomeTerminalReceipt, 'outcome' | 'completedAt'>;
  private readonly observer: ToolContext['onToolOutcomeTerminal'];

  constructor(
    context: Pick<ToolContext, 'onToolOutcomeTerminal'>,
    identity: Omit<ToolOutcomeTerminalReceipt, 'outcome' | 'completedAt'> | undefined,
    parent: ToolOutcomeScope | undefined,
    private readonly aggregate: boolean,
    private readonly mayHaveOwnEffects = true,
  ) {
    this.identity = identity;
    this.observer = context.onToolOutcomeTerminal;
    this.parentSettled = parent?.addChild(this);
  }

  private addChild(child: ToolOutcomeScope): (outcome?: KnownOutcome) => void {
    // Native wrappers close admission before reporting completion. A detached
    // caller cannot change an already published receipt or revive its scope.
    if (this.completed) return () => undefined;
    this.pendingChildren.add(child);
    let settled = false;
    return outcome => {
      if (settled) return;
      settled = true;
      this.pendingChildren.delete(child);
      if (!outcome) {
        this.unknownChild = true;
        this.unknownChildEffects ||= child.hasUnsettledEffects();
      }
      else if (outcome === 'confirmed') this.confirmedChild = true;
      this.maybeComplete();
    };
  }

  markDispatched(): void { this.dispatched = true; }

  /** Used by the runner's lost-wait path, never by model-visible assertions. */
  hasUnsettledEffects(): boolean {
    if (this.unknownChildEffects) return true;
    if (this.dispatched && this.mayHaveOwnEffects && !this.aggregate && !this.ownOutcome) return true;
    for (const child of this.pendingChildren) if (child.hasUnsettledEffects()) return true;
    return false;
  }

  /** Only code_exec calls this, after its owned evaluator actually exited. */
  markEvaluatorClosed(): void {
    this.evaluatorClosed = true;
    this.maybeComplete();
  }

  settle(result: ToolResult | undefined, readOnly: boolean, dispatched: boolean): void {
    if (this.handlerSettled) return;
    this.handlerSettled = true;
    this.dispatched = dispatched;
    if (!dispatched) this.ownOutcome = 'not_applied';
    else if (this.aggregate) {
      // A code_exec proxy error says nothing about a still-running child.
      // The evaluator has no direct effect port; children own all effects.
      this.awaitEvaluator = true;
    } else if (result && result.effectOutcome !== 'unknown') {
      if (result.evidence?.effect === 'none') this.ownOutcome = 'not_applied';
      else if (result.evidence?.effect === 'confirmed') this.ownOutcome = 'confirmed';
      else if (result.isError !== true && result.evidence?.effect !== 'unknown') {
        this.ownOutcome = readOnly ? 'not_applied' : 'confirmed';
      }
    }
    this.maybeComplete();
  }

  private maybeComplete(): void {
    if (this.completed || !this.handlerSettled || this.pendingChildren.size > 0) return;
    if (this.awaitEvaluator && !this.evaluatorClosed) return;
    if (this.awaitEvaluator) this.ownOutcome = 'not_applied';
    this.completed = true;
    const outcome = this.unknownChild || !this.ownOutcome ? undefined
      : this.confirmedChild || this.ownOutcome === 'confirmed' ? 'confirmed' : 'not_applied';
    // Publish descendants before the parent, so durable consumers can retain
    // the causal evidence without an aggregate arriving ahead of its children.
    if (outcome && this.identity) {
      const receipt: ToolOutcomeTerminalReceipt = Object.freeze({
        ...this.identity, outcome, completedAt: new Date().toISOString(),
      });
      try {
        void Promise.resolve(this.observer?.(receipt)).catch(() => undefined);
      } catch { /* Observer/storage failure must not change the tool or clear a guard. */ }
    }
    this.parentSettled?.(outcome);
  }
}

export function createToolOutcomeScope(
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
  aggregate: boolean,
  mayHaveOwnEffects: boolean,
): ToolOutcomeScope | undefined {
  if (!ctx.onToolOutcomeTerminal && !ctx.toolOutcomeScope && !ctx.toolOutcomeControl) return undefined;
  let identity: Omit<ToolOutcomeTerminalReceipt, 'outcome' | 'completedAt'> | undefined;
  if (ctx.onToolOutcomeTerminal && ctx.currentToolUseId && ctx.invocation) {
    try {
      identity = {
        version: 1, toolUseId: ctx.currentToolUseId,
        ...(ctx.parentToolUseId ? { parentToolUseId: ctx.parentToolUseId } : {}),
        invocationId: ctx.invocation.invocationId, toolName: name,
        inputHash: toolOutcomeInputHash(input),
        source: aggregate ? 'code_exec_aggregate' : 'registry',
      };
    } catch { /* Non-JSON input cannot produce a trustworthy identity receipt. */ }
  }
  return new ToolOutcomeScope(ctx, identity, ctx.toolOutcomeScope, aggregate, mayHaveOwnEffects);
}
