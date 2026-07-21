/**
 * Handlers for the `coder` namespace.
 *
 * Dia 2 scope: CRUD over sessions, providers, groups, skills metadata.
 * The heavy operations — `stream.sendMessage` / `attach` / `continueSession`
 * and the `interaction.*` answers — depend on the worker pool + per-session
 * lock and are scheduled for Dia 3. The Hono routes still serve those
 * paths; the Electron IPC stub below throws `not_implemented` so the
 * renderer falls back to HTTP until the worker-pool wiring lands.
 *
 * Source files inventoried:
 *   coder/sessions.ts, coder/providers.ts, coder/groups.ts,
 *   coder/interaction.ts, coder/stream.ts, coder/skills.ts,
 *   coder/state.ts, coder/snapshot.ts, coder/project-files.ts,
 *   coder/project-tree.routes.ts, coder/pipelines.ts, coder/pipelines-state.ts,
 *   coder/active-skills.ts, coder/sessionLock.ts
 */

import {
  ApiError,
  type CoderApi,
  type CoderProvider,
  type CoderSession,
  type CoderEvent,
  type ExecutionMode,
  type SendMessageInput,
  type ContinueSessionInput,
} from '@mcp/api-bus';
import { selectRuntimeModelMetadata } from '@mcp/provider-sdk';
import type { HandlerDeps } from '../types.js';

const EXECUTION_MODES = ['standard', 'ultra'] as const satisfies readonly ExecutionMode[];

function isExecutionMode(value: unknown): value is ExecutionMode {
  return typeof value === 'string' && EXECUTION_MODES.includes(value as ExecutionMode);
}

function normalizeEffort(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() || null : null;
}

export function createCoderHandlers(deps: HandlerDeps): CoderApi {
  const { sessionStore, providerStore } = deps;

  const validateReasoningEffort = (
    provider: string,
    model: string | undefined,
    effort: string | null,
  ): void => {
    if (!effort) return;
    const row = selectRuntimeModelMetadata(providerStore.listModels(provider), model ?? '');
    const supported = row?.supported_reasoning_levels;
    if (supported && supported.length > 0 && !supported.includes(effort)) {
      throw new ApiError(
        'bad_input',
        400,
        `reasoning effort '${effort}' not supported for ${model ?? '(default model)'}; supported: ${supported.join(',')}`,
      );
    }
  };

  return {
    sessions: {
      async list({ projectId, archived, favorite }) {
        if (typeof projectId !== 'number' || !Number.isFinite(projectId)) {
          throw new ApiError('bad_input', 400, 'projectId required');
        }
        const archivedArg = archived === undefined ? false : archived;
        const sessions = sessionStore.listSessions(projectId, {
          archived: archivedArg ? true : false,
        });
        // listSessions doesn't filter by favorite — apply post hoc.
        const filtered = favorite === true ? sessions.filter((s) => s.is_favorite) : sessions;
        return filtered as unknown as CoderSession[];
      },

      async recent({ limit }) {
        const cap = Math.max(1, Math.min(50, limit ?? 10));
        return sessionStore.listRecentSessionsGlobal(cap) as unknown as CoderSession[];
      },

      async get({ id, includeMessages }) {
        if (includeMessages) {
          const data = sessionStore.loadSessionWithMessages(id);
          if (!data) throw new ApiError('not_found', 404, 'session not found');
          return {
            session: data.session as unknown as CoderSession,
            messages: data.messages as unknown[],
          };
        }
        const session = sessionStore.getSession(id);
        if (!session) throw new ApiError('not_found', 404, 'session not found');
        return { session: session as unknown as CoderSession };
      },

      async create(input) {
        if (!input.project_id || !input.title || !input.provider) {
          throw new ApiError('bad_input', 400, 'project_id, title, provider required');
        }
        if (input.execution_mode !== undefined && !isExecutionMode(input.execution_mode)) {
          throw new ApiError('bad_input', 400, `execution_mode: one of ${EXECUTION_MODES.join('|')} required`);
        }
        if (
          input.reasoning_effort !== undefined
          && input.reasoning_effort !== null
          && typeof input.reasoning_effort !== 'string'
        ) {
          throw new ApiError('bad_input', 400, 'reasoning_effort:string|null required');
        }
        const requestedEffort = normalizeEffort(input.reasoning_effort);
        const legacyUltra = requestedEffort?.toLowerCase() === 'ultra';
        const executionMode: ExecutionMode = input.execution_mode
          ?? (legacyUltra ? 'ultra' : 'standard');
        const reasoningEffort = legacyUltra ? null : requestedEffort;
        validateReasoningEffort(input.provider, input.model, reasoningEffort);
        const session = sessionStore.createSession({
          project_id: input.project_id,
          title: input.title,
          provider: input.provider,
          model: input.model ?? '',
          agent: input.agent ?? null,
          phase_profile_id: input.phase_profile_id ?? null,
        });
        sessionStore.setSessionExecutionMode(session.id, executionMode);
        sessionStore.setSessionReasoningEffort(session.id, reasoningEffort);
        const fresh = sessionStore.getSession(session.id);
        if (!fresh) throw new ApiError('not_found', 404, 'session not found');
        return fresh as unknown as CoderSession;
      },

      async update({ id, ...patch }) {
        const existing = sessionStore.getSession(id);
        if (!existing) throw new ApiError('not_found', 404, 'session not found');
        if (patch.title !== undefined) sessionStore.setSessionTitle(id, patch.title);
        if (patch.is_archived !== undefined) sessionStore.setSessionArchived(id, patch.is_archived);
        if (patch.is_favorite !== undefined) sessionStore.setSessionFavorite(id, patch.is_favorite);
        if (patch.group_id !== undefined) sessionStore.setSessionGroup(id, patch.group_id);
        if (patch.unrestricted_tool_output !== undefined) {
          sessionStore.setSessionUnrestrictedToolOutput(id, patch.unrestricted_tool_output ?? null);
        }
        const fresh = sessionStore.getSession(id);
        if (!fresh) throw new ApiError('not_found', 404, 'session not found');
        return fresh as unknown as CoderSession;
      },

      async setExecutionMode({ id, mode }) {
        if (!isExecutionMode(mode)) {
          throw new ApiError('bad_input', 400, `mode: one of ${EXECUTION_MODES.join('|')} required`);
        }
        const existing = sessionStore.getSession(id);
        if (!existing) throw new ApiError('not_found', 404, 'session not found');
        sessionStore.setSessionExecutionMode(id, mode);
        const fresh = sessionStore.getSession(id);
        if (!fresh) throw new ApiError('not_found', 404, 'session not found');
        return fresh as unknown as CoderSession;
      },

      async setReasoningEffort({ id, effort: rawEffort }) {
        if (rawEffort !== null && typeof rawEffort !== 'string') {
          throw new ApiError('bad_input', 400, 'effort:string|null required');
        }
        const effort = normalizeEffort(rawEffort);
        const existing = sessionStore.getSession(id);
        if (!existing) throw new ApiError('not_found', 404, 'session not found');

        // Pre-241 clients exposed Ultra as a pseudo-effort. Preserve their
        // intent without ever storing or forwarding that unsupported sentinel.
        if (effort?.toLowerCase() === 'ultra') {
          sessionStore.setSessionExecutionMode(id, 'ultra');
          sessionStore.setSessionReasoningEffort(id, null);
        } else {
          validateReasoningEffort(existing.provider, existing.model, effort);
          // The legacy effort route is a complete control surface: selecting a
          // native effort or provider default must also leave a prior Ultra mode.
          if (existing.execution_mode_override === 'ultra') {
            sessionStore.setSessionExecutionMode(id, 'standard');
          }
          sessionStore.setSessionReasoningEffort(id, effort);
        }

        const fresh = sessionStore.getSession(id);
        if (!fresh) throw new ApiError('not_found', 404, 'session not found');
        return fresh as unknown as CoderSession;
      },

      async delete({ id }) {
        sessionStore.deleteSession(id);
        return { ok: true as const };
      },

      async messages({ id, cursor, limit }) {
        const session = sessionStore.getSession(id);
        if (!session) throw new ApiError('not_found', 404, 'session not found');
        const beforeId = cursor ? Number(cursor) : 0;
        const cap = Math.max(1, Math.min(100, limit ?? 40));
        if (!beforeId) {
          // First page — load tail (recent N).
          const data = sessionStore.loadSessionMessagesTail(id, cap);
          if (!data) return { items: [], nextCursor: null };
          const oldest = data.message_rows[0];
          return {
            items: data.messages as unknown[],
            nextCursor: oldest ? String(oldest.id) : null,
          };
        }
        const data = sessionStore.loadMessagesBefore(id, beforeId, cap);
        const oldest = data.message_rows[0];
        return {
          items: data.messages as unknown[],
          nextCursor: oldest ? String(oldest.id) : null,
        };
      },
    },

    providers: {
      async list() {
        return providerStore.listProviders() as unknown[];
      },

      async get({ id }) {
        const provider = providerStore.getProvider(id);
        if (!provider) throw new ApiError('not_found', 404, 'provider not found');
        return provider;
      },

      async setActive({ sessionId, provider: _p, model: _m }) {
        const session = sessionStore.getSession(sessionId);
        if (!session) throw new ApiError('not_found', 404, 'session not found');
        // SessionStore exposes only `setSessionFallback`; switching the
        // primary provider/model on an existing session isn't supported
        // by the store yet. Fork-and-recreate is the current pattern;
        // wiring a dedicated mutation is a v1.1 follow-up.
        throw new ApiError(
          'not_implemented',
          501,
          'switching provider/model on an existing session is not yet supported — fork the session instead',
        );
      },

      async test({ provider: _provider, apiKey: _apiKey }) {
        // Connectivity smoke-test is non-trivial — the existing route lives
        // in admin/api-tokens; for now the IDE just trusts the user's key
        // and reports failure on the first real call. Stub kept so the
        // contract surface is complete.
        return { ok: true as const };
      },
    },

    stream: {
      sendMessage(_input: SendMessageInput): AsyncIterable<CoderEvent> {
        // Dia 3 scope: full bus/worker-pool integration. Until then the
        // dashboard hits the legacy Hono /messages SSE endpoint. The
        // Electron IPC bridge will route to this stub; surfacing the
        // 501 makes the dependency explicit instead of returning silent
        // empty streams.
        throw new ApiError('not_implemented', 501, 'coder.stream.sendMessage lands in Dia 3');
      },
      continueSession(_input: ContinueSessionInput): AsyncIterable<CoderEvent> {
        throw new ApiError('not_implemented', 501, 'coder.stream.continueSession lands in Dia 3');
      },
      attach(_input: { sessionId: number; since?: number }): AsyncIterable<CoderEvent> {
        throw new ApiError('not_implemented', 501, 'coder.stream.attach lands in Dia 3');
      },
      async state({ sessionId }) {
        const session = sessionStore.getSession(sessionId);
        if (!session) throw new ApiError('not_found', 404, 'session not found');
        // `alive` requires the activeRuns map which lives in CoderRuntime —
        // we surface it as `false` here and let the Hono route override
        // until the worker-pool integration moves into this handler.
        return {
          sessionId,
          status: session.status,
          alive: false,
          updatedAt: session.updated_at,
        };
      },
      async toolStats({ sessionId, recent }) {
        const session = sessionStore.getSession(sessionId);
        if (!session) throw new ApiError('not_found', 404, 'session not found');
        const cap = Math.max(1, Math.min(200, recent ?? 30));
        const stats = sessionStore.getToolCallStats(sessionId, cap);
        // Cast — store shape mirrors the contract closely enough for the
        // dashboard, which already consumes it.
        return { sessionId, ...stats } as unknown as ReturnType<CoderApi['stream']['toolStats']> extends Promise<infer R> ? R : never;
      },
    },

    interaction: {
      async answer(_input) {
        throw new ApiError('not_implemented', 501, 'coder.interaction.answer lands in Dia 3');
      },
      async planResponse(_input) {
        throw new ApiError('not_implemented', 501, 'coder.interaction.planResponse lands in Dia 3');
      },
      async tasksResponse(_input) {
        throw new ApiError('not_implemented', 501, 'coder.interaction.tasksResponse lands in Dia 3');
      },
    },

    groups: {
      async list({ projectId }) {
        return sessionStore.listGroups(projectId) as Array<{ id: number; name: string; project_id: number }>;
      },
      async create({ projectId, name }) {
        const group = sessionStore.createGroup({ project_id: projectId, name });
        return { id: group.id };
      },
      async update({ id, name }) {
        sessionStore.updateGroup(id, { name });
      },
      async delete({ id }) {
        sessionStore.deleteGroup(id);
      },
    },

    skills: {
      async list() {
        return (deps.skillStore?.listSkills?.() ?? []) as unknown[];
      },
      async get({ id }) {
        const skill = deps.skillStore?.getSkill?.(id);
        if (!skill) throw new ApiError('not_found', 404, 'skill not found');
        return skill;
      },
      async activeForSession({ sessionId }) {
        // Stored on the session as a JSON column; reading via session row.
        const session = sessionStore.getSession(sessionId);
        if (!session) throw new ApiError('not_found', 404, 'session not found');
        const raw = (session as unknown as { active_skills_json?: string }).active_skills_json;
        if (!raw) return [];
        try {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
          return [];
        }
      },
      async setActiveForSession({ sessionId, skillIds }) {
        const session = sessionStore.getSession(sessionId);
        if (!session) throw new ApiError('not_found', 404, 'session not found');
        const setter = (sessionStore as unknown as { setSessionActiveSkills?: (id: number, ids: string[]) => void }).setSessionActiveSkills;
        if (typeof setter === 'function') {
          setter(sessionId, skillIds);
        } else {
          throw new ApiError('not_implemented', 501, 'sessionStore.setSessionActiveSkills not available');
        }
      },
    },
  };
}
