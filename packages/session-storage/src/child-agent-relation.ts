/**
 * Explicit parent → child-agent relation.
 *
 * Stored as the optional top-level `agent_relation` field of session.json,
 * never in the free-form `metadata` bag (forks and duplicates copy that bag
 * whole). Absence means "not a child agent": nothing is inferred from
 * `parent_session_id`, which forks, sub-tabs and Company sessions also set.
 * Only the child-agent creation path writes it.
 */
import type { ChildAgentRelation, SessionId } from './types.js';

/**
 * Children may create grandchildren (owner decision). The cap only stops a
 * runaway creation loop; concurrency is bounded per tree, not by depth.
 */
export const MAX_CHILD_AGENT_DEPTH = 4;

function isWellFormed(value: unknown): value is ChildAgentRelation {
  if (value == null || typeof value !== 'object') return false;
  const { kind, depth } = value as { kind?: unknown; depth?: unknown };
  return kind === 'child_agent' && typeof depth === 'number' && Number.isInteger(depth) && depth >= 1;
}

/** The relation of a stored session, or null when it is not a child agent. */
export function readChildAgentRelation(session: {
  readonly parent_session_id: SessionId | string | null;
  readonly agent_relation?: unknown;
}): ChildAgentRelation | null {
  if (session.parent_session_id == null || !isWellFormed(session.agent_relation)) return null;
  return { kind: 'child_agent', depth: session.agent_relation.depth };
}

/** Validates a relation about to be written; throws on anything malformed. */
export function assertChildAgentRelationInput(
  relation: unknown,
  parentSessionId: SessionId | string | null | undefined,
): ChildAgentRelation {
  if (parentSessionId == null) throw new Error('agent_relation requires parent_session_id');
  if (!isWellFormed(relation)) {
    throw new Error('agent_relation must be { kind: "child_agent", depth: integer >= 1 }');
  }
  return { kind: 'child_agent', depth: relation.depth };
}

/** The relation a new child of `parent` would get (null parent = a root session). */
export function nextChildAgentRelation(parent: ChildAgentRelation | null): ChildAgentRelation {
  return { kind: 'child_agent', depth: (parent?.depth ?? 0) + 1 };
}

/** Whether a session with this relation (null = root) may create a child agent. */
export function canCreateChildAgent(parent: ChildAgentRelation | null): boolean {
  return nextChildAgentRelation(parent).depth <= MAX_CHILD_AGENT_DEPTH;
}
