/**
 * State of a child-agent session: what it inherited from its parent at
 * creation (permission mode, grants, disabled tools) plus its profile and
 * posture. Written together with the bundle in one publish, so a child never
 * exists half-initialized.
 */
import {
  readChildAgentRelation,
  type CatalogEntry,
  type JsonValue,
  type SessionState,
} from '@mcp/session-storage';
import { normalizeStatus } from './session-projection.js';
import { toJsonValue } from './conversation-codec.js';
import type { FsChildAgentConclusion, FsChildAgentSession, FsChildAgentStateSeed } from './types.js';

const CONCLUSION_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'cut_off', 'aborted']);

/** The initial state of a child agent: the ordinary runtime state plus the seed. */
export function childAgentInitialState(
  runtime: { extra: Readonly<Record<string, JsonValue>> },
  seed: FsChildAgentStateSeed,
): Pick<SessionState, 'extra' | 'permissions' | 'tools'> {
  const grants = [...new Set(seed.permission_grants)].sort();
  const disabled = [...new Set(seed.disabled_tools)].sort();
  return {
    extra: {
      ...runtime.extra,
      child_agent: toJsonValue({
        profile: seed.profile,
        read_only: seed.read_only,
        creation_fingerprint: seed.creation_fingerprint,
      }),
    },
    permissions: {
      ...(seed.permission_mode != null ? { mode: seed.permission_mode } : {}),
      ...(grants.length > 0 ? { grants } : {}),
    },
    tools: disabled.length > 0 ? { disabled } : {},
  };
}

function childAgentRecord(state: SessionState): Readonly<Record<string, JsonValue>> {
  const value = state.extra.child_agent;
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>> : {};
}

const text = (value: JsonValue | undefined) => (typeof value === 'string' ? value : null);

/** The recorded conclusion of the child's latest run, or null. */
export function childAgentConclusion(state: SessionState): FsChildAgentConclusion | null {
  const value = childAgentRecord(state).conclusion;
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, JsonValue>>;
  if (typeof record.run_id !== 'string' || typeof record.state !== 'string' || !CONCLUSION_STATES.has(record.state)) return null;
  const usage = record.usage != null && typeof record.usage === 'object' && !Array.isArray(record.usage)
    ? record.usage as Readonly<Record<string, JsonValue>> : {};
  const count = (key: string) => (typeof usage[key] === 'number' ? usage[key] as number : 0);
  return {
    run_id: record.run_id,
    state: record.state as FsChildAgentConclusion['state'],
    reason: text(record.reason) ?? record.state,
    finished_at: text(record.finished_at) ?? '',
    final_text: text(record.final_text),
    changed_files: Array.isArray(record.changed_files) ? record.changed_files.filter((path): path is string => typeof path === 'string') : [],
    usage: { input_tokens: count('input_tokens'), output_tokens: count('output_tokens'),
      cache_read_input_tokens: count('cache_read_input_tokens'), cache_creation_input_tokens: count('cache_creation_input_tokens') },
  };
}

/** The state with a new run conclusion, every other child field kept. */
export function withChildAgentConclusion(state: SessionState, conclusion: FsChildAgentConclusion): SessionState {
  return {
    ...state,
    extra: { ...state.extra, child_agent: toJsonValue({ ...childAgentRecord(state), conclusion: { ...conclusion } }) },
  };
}

function childAgentFields(state: SessionState) {
  const record = childAgentRecord(state);
  return {
    profile: typeof record.profile === 'string' ? record.profile : null,
    read_only: record.read_only === true,
    creation_fingerprint: typeof record.creation_fingerprint === 'string' ? record.creation_fingerprint : null,
  };
}

/** The child-agent view of a catalog entry, or null when it is not a child agent. */
export function summarizeChildAgent(
  entry: CatalogEntry,
  readState: (entry: CatalogEntry) => SessionState,
): FsChildAgentSession | null {
  const relation = readChildAgentRelation(entry.session);
  const parent = entry.session.parent_session_id;
  if (!relation || parent == null) return null;
  const state = entry.state ?? readState(entry);
  return {
    id: entry.session.id,
    parent_session_id: parent,
    depth: relation.depth,
    status: normalizeStatus(state.status),
    is_archived: state.archived_at != null,
    updated_at: entry.session.updated_at,
    created_at: entry.session.created_at,
    ...childAgentFields(state),
    conclusion: childAgentConclusion(state),
  };
}
