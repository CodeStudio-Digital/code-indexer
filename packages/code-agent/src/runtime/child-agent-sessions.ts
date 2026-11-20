/**
 * Child-agent sessions: a real session nested under the session that created
 * it, with the explicit child-agent relation and depth, its profile, and a
 * snapshot of the parent's authority taken at creation. Never more permissive
 * than the parent.
 *
 * Separate from the peer network (`SessionNetwork.create`): no Agêntico gate,
 * no network spawn slots, no mailbox. Creation is idempotent per key and
 * atomic: every inherited setting is published with the bundle in one step.
 * Running the child (profile allowlist, budgets) is not decided here.
 */
import { asSessionId, canCreateChildAgent, MAX_CHILD_AGENT_DEPTH, nextChildAgentRelation, type SessionId } from '@mcp/session-storage';
import type { FsChildAgentSession, FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { keyOf } from '@mcp/session-storage/collaboration/files.js';
import { isReadOnlyAgent } from '../agents/index.js';
import { resolveMicroAgentProfile } from '../tools/micro-agent-profiles.js';
import type { NetworkProject } from './session-network.js';
import { assertTreeCanCreateChild, childAgentRoot } from './child-agent-tree.js';

export type ChildAgentSessionStore = Pick<FsSessionStore,
  'getSession' | 'createSession' | 'getSessionDisabledTools' | 'getChildAgentSession' | 'listChildAgentSessions'>;

export interface ChildAgentSessionOptions {
  sessions: ChildAgentSessionStore;
  project(id: number): NetworkProject | null | undefined;
  validateModel?(provider: string, model: string): void;
  /**
   * The profile's configured model and effort (subagent.ts, keyed by the
   * creator's provider, as the in-process resolver does). Used when the
   * request does not pin its own.
   */
  resolveProfileTarget?(creatorProvider: string, profileId: string): ChildAgentProfileTarget | undefined;
  /** Clock for the per-tree creation window; tests move it. */
  now?(): Date;
}

export interface ChildAgentProfileTarget {
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
}

export interface ChildAgentRequest {
  /** Idempotency key: the same key under the same parent names the same child. */
  key: string;
  title: string;
  /** explore, implement, verify, review or full (aliases accepted). */
  profile: string;
  /** Defaults to the parent's project; must be it or one linked to the parent. */
  projectId?: number;
  provider?: string;
  model?: string;
  effort?: string;
  /** Live posture of the parent run (plan mode, a read-only agent), from the caller. */
  parentReadOnly?: boolean;
}

/**
 * Capability of each profile, from its allowlist (micro-agent-profiles.ts):
 * explore and review only read (review is a subset of explore), verify adds
 * the shell, implement adds native writes and every external MCP, full is
 * unfiltered. A descendant never ranks above the child agent creating it.
 */
const PROFILE_RANK: Readonly<Record<string, number>> = { explore: 0, review: 0, verify: 1, implement: 2, full: 3 };
const READ_RANK = 0;

function childSessionId(parentId: string, key: string): SessionId {
  // Same UUID shape as network children, in a separate key namespace.
  const hash = keyOf(`child-agent\n${parentId}\n${key}`);
  return asSessionId(`${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`);
}

function grantsOf(serialized: string | null): string[] {
  if (!serialized) return [];
  const parsed: unknown = JSON.parse(serialized);
  return Array.isArray(parsed) ? parsed.filter((grant): grant is string => typeof grant === 'string') : [];
}

async function adopt(sessions: ChildAgentSessionStore, id: SessionId, fingerprint: string): Promise<FsChildAgentSession | null> {
  const existing = await sessions.getChildAgentSession(id);
  if (!existing) {
    if (await sessions.getSession(id)) throw new Error('Creation key collides with a session that is not a child agent');
    return null;
  }
  if (existing.creation_fingerprint !== fingerprint) throw new Error('Creation key reused with different settings');
  return existing;
}

export async function createChildAgentSession(
  options: ChildAgentSessionOptions,
  parentId: string,
  request: ChildAgentRequest,
): Promise<{ child: FsChildAgentSession; created: boolean }> {
  const { sessions } = options;
  if (typeof request.key !== 'string' || !request.key || request.key.length > 200) throw new Error('A child agent needs a creation key');
  const title = typeof request.title === 'string' ? request.title.trim() : '';
  if (!title || title.length > 160) throw new Error('A child agent needs a title of at most 160 characters');
  const profile = resolveMicroAgentProfile(request.profile);
  if (!profile) throw new Error(`Unknown child-agent profile '${String(request.profile)}'`);

  const parent = await sessions.getSession(parentId);
  if (!parent || parent.kind !== 'coder' || parent.is_archived) throw new Error('Parent session is unavailable');
  // The creator's own child-agent view; null when it is a root session.
  const asChild = await sessions.getChildAgentSession(parent.id);
  const parentRelation = asChild ? { kind: 'child_agent' as const, depth: asChild.depth } : null;
  if (!canCreateChildAgent(parentRelation)) throw new Error(`Child-agent depth limit reached (${MAX_CHILD_AGENT_DEPTH} levels)`);

  const projectId = request.projectId ?? parent.project_id;
  const allowed = new Set([parent.project_id, ...parent.linked_projects.map((linked) => linked.project_id)]);
  if (projectId == null || !allowed.has(projectId)) throw new Error('The child agent project must be the parent project or one linked to it');
  const project = Number.isSafeInteger(projectId) ? options.project(projectId) : null;
  if (!project || project.is_synthetic || !project.root_path.trim()) throw new Error('Project is unavailable');
  // Model and effort: the request's, else the profile's configured target,
  // else the creator's own.
  const target = options.resolveProfileTarget?.(parent.provider, profile.id);
  const pinned = !!(request.provider || request.model);
  const fromProfile = !pinned && target?.provider && target.model ? target : null;
  const provider = request.provider || fromProfile?.provider || parent.provider;
  const model = request.model || fromProfile?.model || parent.model;
  const effort = request.effort?.trim() || target?.effort || parent.reasoning_effort_override;
  options.validateModel?.(provider, model);

  // A child agent never creates a more capable descendant. A seedless
  // relation has no recorded profile and counts as read-level.
  const creatorRank = asChild ? PROFILE_RANK[asChild.profile ?? ''] ?? READ_RANK : PROFILE_RANK.full!;
  if (PROFILE_RANK[profile.id]! > creatorRank) {
    throw new Error(`A '${asChild?.profile ?? 'read-level'}' child agent cannot create a more capable '${profile.id}' descendant`);
  }
  // Plan mode, read-only agents, read-only or read-level creators all yield
  // a read-only child, so the posture passes down every level.
  const readOnly = request.parentReadOnly === true || parent.agent === 'plan' || isReadOnlyAgent(parent.agent)
    || asChild?.read_only === true || (asChild != null && creatorRank === READ_RANK);
  if (readOnly && PROFILE_RANK[profile.id] !== READ_RANK) {
    throw new Error(`A read-only parent can only create read-only children (explore or review), not '${profile.id}'`);
  }
  const fingerprint = keyOf(JSON.stringify({ title, profile: profile.id, projectId, provider, model, effort, readOnly }));
  const childId = childSessionId(parent.id, request.key);
  const existing = await adopt(sessions, childId, fingerprint);
  if (existing) return { child: existing, created: false };
  // A retried creation adopts above; only a new child counts against the tree.
  await assertTreeCanCreateChild(sessions, await childAgentRoot(sessions, parent.id), options.now?.());

  await sessions.createSession({
    id: childId,
    parent_session_id: parent.id,
    agent_relation: nextChildAgentRelation(parentRelation),
    project_id: projectId,
    title,
    provider,
    model,
    // The parent's agent keeps its restrictions; a read-only posture becomes
    // the read-only agent so dispatch refuses writes even before profiles apply.
    agent: readOnly ? 'explore' : parent.agent,
    worktree_path: projectId === parent.project_id ? parent.worktree_path : null,
    execution_mode_override: 'standard',
    reasoning_effort_override: effort,
    thinking_enabled: parent.thinking_enabled,
    max_turns: parent.max_turns,
    max_auto_continues: parent.max_auto_continues,
    child_agent_state: {
      profile: profile.id,
      read_only: readOnly,
      creation_fingerprint: fingerprint,
      permission_mode: parent.tool_permission_mode,
      permission_grants: grantsOf(parent.tool_permission_grants),
      disabled_tools: [...await sessions.getSessionDisabledTools(parent.id)],
    },
  });
  const child = await sessions.getChildAgentSession(childId);
  if (!child) throw new Error('Child-agent session was not published');
  return { child, created: true };
}
