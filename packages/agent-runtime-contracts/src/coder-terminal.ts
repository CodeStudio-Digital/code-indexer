/**
 * One terminal vocabulary for the Coder runner, transport, command ledger and
 * AgentRun projection. A failure-class runner reason must never become a
 * successful command merely because an older transport labelled it `done`.
 */
export type CoderTerminalClassification =
  | 'completed'
  | 'interrupted'
  | 'cancelled'
  | 'failed';

export interface CoderTerminalOutcomeInput {
  event?: 'done' | 'error';
  reason?: unknown;
  error?: unknown;
  message?: unknown;
}

export interface ClassifiedCoderTerminalOutcome {
  classification: CoderTerminalClassification;
  /** Canonical transport event. Interrupted/cancelled runs still close cleanly. */
  event: 'done' | 'error';
  reason: string;
  error?: string;
  message?: string;
}

const INTERRUPTED_REASONS = new Set([
  'max_turns',
  'tool_budget',
  'time_budget',
]);

const CANCELLED_REASONS = new Set([
  'aborted',
  'cancelled',
]);

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Classify a terminal signal defensively. `completed` is the only explicit
 * success reason; unknown non-empty reasons fail closed so newly introduced
 * runner failures cannot silently regress into durable success.
 */
export function classifyCoderTerminalOutcome(
  input: CoderTerminalOutcomeInput,
): ClassifiedCoderTerminalOutcome {
  const explicitError = nonEmptyString(input.error);
  const explicitMessage = nonEmptyString(input.message);
  const reason = nonEmptyString(input.reason)
    ?? (input.event === 'error' || explicitError ? 'error' : 'completed');

  let classification: CoderTerminalClassification;
  if (CANCELLED_REASONS.has(reason)) {
    classification = 'cancelled';
  } else if (input.event === 'error' || explicitError) {
    classification = 'failed';
  } else if (INTERRUPTED_REASONS.has(reason)) {
    classification = 'interrupted';
  } else if (reason === 'completed') {
    classification = 'completed';
  } else {
    classification = 'failed';
  }

  const event = classification === 'failed' ? 'error' : 'done';
  const message = classification === 'failed'
    ? explicitMessage ?? explicitError ?? reason
    : explicitMessage;

  return {
    classification,
    event,
    reason,
    ...(explicitError ? { error: explicitError } : {}),
    ...(message ? { message } : {}),
  };
}

/**
 * Preserve transport metadata while enforcing the canonical event/reason and
 * the renderer-compatible `message` field for every failure.
 */
export function normalizeCoderTerminalSignal(
  event: 'done' | 'error',
  data: unknown,
): { event: 'done' | 'error'; data: Record<string, unknown> } {
  const record = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
  const classified = classifyCoderTerminalOutcome({
    event,
    reason: record.reason,
    error: record.error,
    message: record.message,
  });
  return {
    event: classified.event,
    data: {
      ...record,
      reason: classified.reason,
      ...(classified.error ? { error: classified.error } : {}),
      ...(classified.message ? { message: classified.message } : {}),
    },
  };
}
