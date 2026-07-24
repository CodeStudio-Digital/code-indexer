/**
 * Invocation-scoped duplicate protection.
 *
 * Stable reads are never refused across turns. The default hybrid policy only
 * hard-stops the third identical mutating invocation in the same local scope
 * while no other write/execute has advanced the state epoch. Cross-turn
 * no-progress detection lives in `no-progress.ts` and is observation-only.
 */
import type {
  CoderTool,
  GuardVerdict,
  ToolRepeatPolicy,
} from '@mcp/code-agent/core/tool.js';
import { aliasNormalizationEnabled, normalizeToolArgs } from '@mcp/code-agent/core/tool-arg-aliases.js';
import type { DupCallEntry } from '../machine/types.js';
import { previewToolArgs, stableArgsKey } from '../dup-utils.js';

export const DUP_REFUSE_MIN = 3;

export type DedupPolicyMode = 'hybrid' | 'observe' | 'legacy';

/** Resolve on every call so tests/operators can change the kill switch live. */
export function dedupPolicyMode(): DedupPolicyMode {
  const raw = process.env.CODER_DEDUP_POLICY?.trim().toLowerCase();
  return raw === 'observe' || raw === 'legacy' ? raw : 'hybrid';
}

interface InvocationGuardEntry extends DupCallEntry {
  stateEpoch: number;
}

/** Local to one direct batch or one code_exec instance. */
export class InvocationGuardState {
  readonly entries = new Map<string, InvocationGuardEntry>();

  constructor(public stateEpoch = 0) {}

  /**
   * A successful write/execute invalidates every unrelated signature. The
   * operation that caused the state change keeps its count, otherwise three
   * identical writes could never reach the safety stop because each write
   * advances the epoch itself.
   */
  noteStateChange(originKey?: string): number {
    this.stateEpoch += 1;
    for (const [key, entry] of this.entries) {
      if (key === originKey) {
        entry.stateEpoch = this.stateEpoch;
      } else {
        this.entries.delete(key);
      }
    }
    return this.stateEpoch;
  }

  /** External state changed between calls; all local repetition is stale. */
  syncEpoch(epoch: number): void {
    if (!Number.isFinite(epoch) || epoch === this.stateEpoch) return;
    this.stateEpoch = Math.max(0, Math.floor(epoch));
    this.entries.clear();
  }
}

export function createInvocationGuardState(stateEpoch = 0): InvocationGuardState {
  return new InvocationGuardState(stateEpoch);
}

/** Canonical effective input shared by gates, handlers and equality/signatures. */
export function normalizeGuardInput(
  tool: Pick<CoderTool, 'parameters'> | null | undefined,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const aliased = tool && aliasNormalizationEnabled()
    ? normalizeToolArgs(tool.parameters, input)
    : input;
  const properties = tool?.parameters?.properties;
  if (!properties || typeof properties !== 'object') return aliased;
  let out: Record<string, unknown> | null = null;
  for (const [name, schema] of Object.entries(properties)) {
    if (Object.prototype.hasOwnProperty.call(aliased, name)) continue;
    if (!schema || typeof schema !== 'object' || !Object.prototype.hasOwnProperty.call(schema, 'default')) continue;
    if (!out) out = { ...aliased };
    out[name] = (schema as { default?: unknown }).default;
  }
  return out ?? aliased;
}

export function invocationGuardKey(name: string, normalizedInput: unknown): string {
  return `${name}|${stableArgsKey(normalizedInput)}`;
}

type VerdictCommon = GuardVerdict & {
  entry: DupCallEntry;
  key: string;
};

export type DupVerdict =
  | (VerdictCommon & { kind: 'allow'; action: 'allow' })
  | (VerdictCommon & {
      kind: 'allow-with-reminder';
      action: 'warn';
      reminderText: string;
    })
  | (VerdictCommon & {
      kind: 'refuse';
      action: 'block';
      refusalKind: 'dedup';
      refuseText: string;
    })
  | (VerdictCommon & {
      kind: 'shadow';
      action: 'shadow';
      wouldBlock: true;
      reminderText: string;
    });

export interface CheckDupArgs {
  name: string;
  input: unknown;
  /** Input after alias/default normalization; raw input remains user-facing. */
  normalizedInput?: unknown;
  /** Legacy compatibility; prefer repeatPolicy. */
  isRepeatable?: boolean;
  repeatPolicy?: ToolRepeatPolicy;
  turn: number;
  useId: string;
  /** Legacy run-wide table, consulted only in CODER_DEDUP_POLICY=legacy. */
  dupCalls?: Map<string, DupCallEntry>;
  /** Local state for hybrid/observe. Created by the caller per invocation scope. */
  invocationState?: InvocationGuardState;
  stateEpoch?: number;
  forceReread?: boolean;
}

export function checkDupCall(args: CheckDupArgs): DupVerdict {
  const normalizedInput = args.normalizedInput ?? args.input;
  const key = invocationGuardKey(args.name, normalizedInput);
  const repeatPolicy = args.repeatPolicy ?? (args.isRepeatable ? 'pollable' : 'stable');
  const mode = dedupPolicyMode();

  if (args.forceReread === true || isForceReread(args.input)) {
    return allowVerdict(args, key, 'force-reread', args.stateEpoch ?? args.invocationState?.stateEpoch ?? 0);
  }

  if (mode === 'legacy') {
    return checkLegacy({ ...args, key, repeatPolicy });
  }

  // Reads/snapshots can be coalesced by the caller inside this scope, but a
  // historical occurrence is never a reason to refuse. Volatile and pollable
  // calls must execute; polling-stuck owns unchanged poll results.
  if (repeatPolicy !== 'mutating') {
    return allowVerdict(args, key, `${repeatPolicy}-allowed`, args.stateEpoch ?? args.invocationState?.stateEpoch ?? 0);
  }

  const state = args.invocationState ?? createInvocationGuardState(args.stateEpoch ?? 0);
  if (args.stateEpoch !== undefined) state.syncEpoch(args.stateEpoch);
  const previous = state.entries.get(key);
  const entry: InvocationGuardEntry = previous && previous.stateEpoch === state.stateEpoch
    ? {
        count: previous.count + 1,
        firstTurn: previous.firstTurn,
        lastUseId: args.useId,
        stateEpoch: state.stateEpoch,
      }
    : {
        count: 1,
        firstTurn: args.turn,
        lastUseId: args.useId,
        stateEpoch: state.stateEpoch,
      };
  state.entries.set(key, entry);

  if (entry.count === 1) {
    return {
      kind: 'allow',
      action: 'allow',
      reason: 'mutating-first-at-epoch',
      shouldReflect: false,
      affectsFailureStreak: true,
      count: entry.count,
      sourceTool: args.name,
      originToolUseId: args.useId,
      stateEpoch: state.stateEpoch,
      entry,
      key,
    };
  }

  const reminderText = buildReminderText({
    name: args.name,
    input: normalizedInput,
    firstTurn: entry.firstTurn,
    mutating: true,
  });
  if (entry.count < DUP_REFUSE_MIN) {
    return {
      kind: 'allow-with-reminder',
      action: 'warn',
      reason: 'mutating-repeat-warning',
      shouldReflect: false,
      affectsFailureStreak: true,
      count: entry.count,
      sourceTool: args.name,
      originToolUseId: args.useId,
      stateEpoch: state.stateEpoch,
      entry,
      key,
      reminderText,
    };
  }

  if (mode === 'observe') {
    return {
      kind: 'shadow',
      action: 'shadow',
      reason: 'mutating-repeat-shadow',
      shouldReflect: false,
      affectsFailureStreak: false,
      count: entry.count,
      sourceTool: args.name,
      originToolUseId: args.useId,
      stateEpoch: state.stateEpoch,
      wouldBlock: true,
      entry,
      key,
      reminderText,
    };
  }

  return {
    kind: 'refuse',
    action: 'block',
    reason: 'mutating-repeat-blocked',
    refusalKind: 'dedup',
    shouldReflect: true,
    affectsFailureStreak: false,
    count: entry.count,
    sourceTool: args.name,
    originToolUseId: args.useId,
    stateEpoch: state.stateEpoch,
    entry,
    key,
    refuseText: buildRefuseText({
      name: args.name,
      input: normalizedInput,
      firstTurn: entry.firstTurn,
      count: entry.count,
    }),
  };
}

function checkLegacy(
  args: CheckDupArgs & { key: string; repeatPolicy: ToolRepeatPolicy },
): DupVerdict {
  const table = args.dupCalls ?? new Map<string, DupCallEntry>();
  if (args.repeatPolicy === 'pollable' || args.repeatPolicy === 'volatile') {
    return allowVerdict(args, args.key, 'legacy-repeatable', 0);
  }
  const previous = table.get(args.key);
  const entry: DupCallEntry = previous
    ? { count: previous.count + 1, firstTurn: previous.firstTurn, lastUseId: args.useId }
    : { count: 1, firstTurn: args.turn, lastUseId: args.useId };
  table.set(args.key, entry);
  const common = {
    count: entry.count,
    sourceTool: args.name,
    originToolUseId: args.useId,
    stateEpoch: 0,
    entry,
    key: args.key,
  };
  if (entry.count === 1) {
    return {
      ...common,
      kind: 'allow',
      action: 'allow',
      reason: 'legacy-first-call',
      shouldReflect: false,
      affectsFailureStreak: true,
    };
  }
  if (entry.count < DUP_REFUSE_MIN) {
    return {
      ...common,
      kind: 'allow-with-reminder',
      action: 'warn',
      reason: 'legacy-repeat-warning',
      shouldReflect: false,
      affectsFailureStreak: true,
      reminderText: buildReminderText({
        name: args.name,
        input: args.normalizedInput ?? args.input,
        firstTurn: entry.firstTurn,
      }),
    };
  }
  return {
    ...common,
    kind: 'refuse',
    action: 'block',
    reason: 'legacy-repeat-blocked',
    refusalKind: 'dedup',
    shouldReflect: true,
    affectsFailureStreak: false,
    refuseText: buildRefuseText({
      name: args.name,
      input: args.normalizedInput ?? args.input,
      firstTurn: entry.firstTurn,
      count: entry.count,
    }),
  };
}

function allowVerdict(
  args: Pick<CheckDupArgs, 'name' | 'turn' | 'useId'>,
  key: string,
  reason: string,
  stateEpoch: number,
): DupVerdict {
  const entry = { count: 0, firstTurn: args.turn, lastUseId: args.useId };
  return {
    kind: 'allow',
    action: 'allow',
    reason,
    shouldReflect: false,
    affectsFailureStreak: true,
    count: 0,
    sourceTool: args.name,
    originToolUseId: args.useId,
    stateEpoch,
    entry,
    key,
  };
}

function isForceReread(input: unknown): boolean {
  return !!input && typeof input === 'object' &&
    (input as Record<string, unknown>).force_reread === true;
}

function buildReminderText(args: {
  name: string;
  input: unknown;
  firstTurn: number;
  mutating?: boolean;
}): string {
  const argsPreview = previewToolArgs(args.input);
  const suffix = args.mutating
    ? 'A third identical mutation without another state-changing operation will be refused.'
    : 'Use the result already attached before repeating this exact call.';
  return (
    `<system-reminder>` +
    `[dedup: 2nd identical call to \`${args.name}\` (1st at turn ${args.firstTurn}, args=${argsPreview}). ` +
    `${suffix}]` +
    `</system-reminder>\n`
  );
}

function buildRefuseText(args: {
  name: string;
  input: unknown;
  firstTurn: number;
  count: number;
}): string {
  const argsPreview = previewToolArgs(args.input);
  return (
    `[loop-refused: identical mutating call to \`${args.name}\` ` +
    `(call #${args.count}, first at turn ${args.firstTurn}, args=${argsPreview}). ` +
    `Reflect on the prior results or perform a different state-changing step before retrying.]`
  );
}

/** Compatibility helper for legacy tests/rollback state. */
export function resetDupCalls(dupCalls: Map<string, DupCallEntry>): void {
  dupCalls.clear();
}
