/**
 * Tuple-hash anti-loop guard. Mirrors Kimi's `_dedup_tool_calls`
 * (`kimi-cli/src/kimi_cli/soul/kimisoul.py:1082-1084`): the agent gets a
 * verbal nudge on the 2nd identical call, and a hard refuse on the 3rd.
 *
 * The legacy `DUP_CALL_THRESHOLD` (5 calls) was too tardy — the agent
 * already burned tokens repeating the call 4 times before the guard fired.
 * This guard catches the loop on call #2 (system-reminder) and stops it on
 * call #3 (refuse + ToolLoopDetected event → routes to Planning).
 *
 * Polling tools — those matching `REPEATABLE_NAME_PATTERN` or with
 * `CoderTool.repeatable=true` — are exempt; repeated identical calls are
 * their LEGITIMATE workflow, not a loop signal.
 */
import type { DupCallEntry } from '../machine/types.js';
import { stableArgsKey, previewToolArgs } from '../dup-utils.js';
import { REPEATABLE_NAME_PATTERN } from '../constants.js';

export type DupVerdict =
  | { kind: 'allow'; entry: DupCallEntry; key: string }
  | { kind: 'allow-with-reminder'; entry: DupCallEntry; key: string; reminderText: string }
  | { kind: 'refuse'; entry: DupCallEntry; key: string; refuseText: string };

export interface CheckDupArgs {
  /** Tool name (matches `CoderTool.name`). */
  name: string;
  /** Tool input as provided by the model. */
  input: unknown;
  /** Whether `CoderTool.repeatable=true`. Polling tools never dedup. */
  isRepeatable: boolean;
  /** Current turn number for telemetry / first-seen tracking. */
  turn: number;
  /** Tool-use block id of THIS call (latest). */
  useId: string;
  /** Mutable state — caller threads in `ctx.dupCalls`. */
  dupCalls: Map<string, DupCallEntry>;
}

/**
 * Inspect a tool call against the dedup table. The call should ALWAYS be
 * dispatched on `allow` / `allow-with-reminder` — the reminder is prepended
 * to the tool_result content, not used to skip dispatch. On `refuse` the
 * caller MUST NOT dispatch and SHOULD synthesize a `tool_result` with
 * `is_error: true` carrying `refuseText`.
 */
export function checkDupCall(args: CheckDupArgs): DupVerdict {
  const key = `${args.name}|${stableArgsKey(args.input)}`;

  // Polling tools: convention-based exemption. We never register them so
  // the table never grows for legit polling workflows (mcp__list_*, *_status).
  if (args.isRepeatable || REPEATABLE_NAME_PATTERN.test(args.name)) {
    return {
      kind: 'allow',
      entry: { count: 0, firstTurn: args.turn, lastUseId: args.useId },
      key,
    };
  }

  const prev = args.dupCalls.get(key);
  if (!prev) {
    const entry: DupCallEntry = {
      count: 1,
      firstTurn: args.turn,
      lastUseId: args.useId,
    };
    args.dupCalls.set(key, entry);
    return { kind: 'allow', entry, key };
  }

  const entry: DupCallEntry = {
    count: prev.count + 1,
    firstTurn: prev.firstTurn,
    lastUseId: args.useId,
  };
  args.dupCalls.set(key, entry);

  if (entry.count === 2) {
    return {
      kind: 'allow-with-reminder',
      entry,
      key,
      reminderText: buildReminderText({
        name: args.name,
        input: args.input,
        firstTurn: entry.firstTurn,
      }),
    };
  }

  return {
    kind: 'refuse',
    entry,
    key,
    refuseText: buildRefuseText({
      name: args.name,
      input: args.input,
      firstTurn: entry.firstTurn,
      count: entry.count,
    }),
  };
}

function buildReminderText(args: {
  name: string;
  input: unknown;
  firstTurn: number;
}): string {
  const argsPreview = previewToolArgs(args.input);
  return (
    `<system-reminder>` +
    `[dedup: 2nd identical call to \`${args.name}\` (1st at turn ${args.firstTurn}, args=${argsPreview}). ` +
    `Result attached. Use what you already have — repeating this exact call will be refused.]` +
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
    `[loop-refused: identical call to \`${args.name}\` (call #${args.count}, first at turn ${args.firstTurn}, args=${argsPreview}). ` +
    `Forcing a planning turn — review the prior results before retrying.]`
  );
}

/**
 * Reset the dedup table. The orchestrator calls this after a Planning turn
 * so the agent gets a clean slate to break out of the loop (otherwise it
 * would still see "refuse" on the next attempt and stay stuck).
 */
export function resetDupCalls(dupCalls: Map<string, DupCallEntry>): void {
  dupCalls.clear();
}
