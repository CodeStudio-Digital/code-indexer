import {
  newSessionId,
  type JsonValue,
  type SessionId,
} from '@mcp/session-storage';
import { toJsonValue } from './conversation-codec.js';
import {
  runtimeFromState,
  toolsetFromState,
} from './advanced-state-codec.js';
import { FsSessionDirectory } from './session-directory.js';
import { FsSessionEntityFiles } from './entity-files.js';
import type {
  CoderExecutionMode,
  FsPendingAgentTransition,
  FsRuntimeSessionState,
  FsToolOutputCapLevel,
  FsToolsetState,
} from './operational-types.js';

const PROFILE_RANK = { bootstrap: 0, navigate: 1, full: 2 } as const;

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string'))]
    : [];
}

export class FsAdvancedStateRepository {
  constructor(
    private readonly directory: FsSessionDirectory,
    private readonly entities: FsSessionEntityFiles,
  ) {}

  async get(id: SessionId | string): Promise<FsRuntimeSessionState> {
    const entry = await this.directory.requireEntry(id);
    return runtimeFromState(
      entry.state ??
        this.directory.repository.readStateSync(entry.location),
    );
  }

  private mutate(
    id: SessionId | string,
    update: (current: FsRuntimeSessionState) => FsRuntimeSessionState,
  ): Promise<FsRuntimeSessionState> {
    return this.directory.runMutation(id, async () => {
      const entry = await this.directory.requireEntry(id);
      const state = await this.directory.repository.updateState(
        entry.location,
        (current) => {
          const next = update(runtimeFromState(current));
          return {
            ...current,
            extra: {
              ...current.extra,
              runtime: toJsonValue(next),
            },
          };
        },
      );
      return runtimeFromState(state);
    });
  }

  setTemperature(id: SessionId | string, value: number | null): Promise<void> {
    return this.mutate(id, (current) => ({
      ...current,
      temperature_override: value,
    })).then(() => undefined);
  }

  setReasoningEffort(
    id: SessionId | string,
    effort: string | null,
  ): Promise<void> {
    const normalized = effort?.trim() || null;
    return this.mutate(id, (current) => ({
      ...current,
      ...(normalized?.toLowerCase() === 'ultra'
        ? {
            reasoning_effort_override: null,
            execution_mode_override: 'ultra' as const,
          }
        : { reasoning_effort_override: normalized }),
    })).then(() => undefined);
  }

  setExecutionMode(
    id: SessionId | string,
    mode: CoderExecutionMode,
  ): Promise<void> {
    return this.mutate(id, (current) => ({
      ...current,
      execution_mode_override: mode,
    })).then(() => undefined);
  }

  setThinkingEnabled(id: SessionId | string, enabled: boolean): Promise<void> {
    return this.mutate(id, (current) => ({
      ...current,
      thinking_enabled: enabled,
    })).then(() => undefined);
  }

  setBlockCodeComments(id: SessionId | string, enabled: boolean): Promise<void> {
    return this.mutate(id, (current) => ({
      ...current,
      block_code_comments: enabled,
    })).then(() => undefined);
  }

  setRunLimits(
    id: SessionId | string,
    maxTurns: number | null,
    maxAutoContinues: number,
  ): Promise<void> {
    return this.mutate(id, (current) => ({
      ...current,
      max_turns: maxTurns,
      max_auto_continues: maxAutoContinues,
    })).then(() => undefined);
  }

  private setNullableString(
    id: SessionId | string,
    key:
      | 'plan_depth_override'
      | 'response_language_override'
      | 'output_style_override'
      | 'preflight_seed_json'
      | 'worktree_path'
      | 'base_commit_sha',
    value: string | null,
  ): Promise<void> {
    return this.mutate(id, (current) => ({
      ...current,
      [key]: value,
    })).then(() => undefined);
  }

  setPlanDepth(id: SessionId | string, value: string | null): Promise<void> {
    return this.setNullableString(id, 'plan_depth_override', value);
  }

  setResponseLanguage(
    id: SessionId | string,
    value: string | null,
  ): Promise<void> {
    return this.setNullableString(id, 'response_language_override', value);
  }

  setOutputStyle(id: SessionId | string, value: string | null): Promise<void> {
    return this.setNullableString(id, 'output_style_override', value);
  }

  setPreflightSeed(id: SessionId | string, value: string | null): Promise<void> {
    return this.setNullableString(id, 'preflight_seed_json', value);
  }

  setWorktree(id: SessionId | string, value: string | null): Promise<void> {
    return this.setNullableString(id, 'worktree_path', value);
  }

  setBaseCommit(id: SessionId | string, value: string | null): Promise<void> {
    return this.setNullableString(id, 'base_commit_sha', value);
  }

  setUnrestrictedToolOutput(
    id: SessionId | string,
    value: boolean | null,
  ): Promise<void> {
    return this.mutate(id, (current) => ({
      ...current,
      unrestricted_tool_output: value,
    })).then(() => undefined);
  }

  setToolOutputCapLevel(
    id: SessionId | string,
    value: FsToolOutputCapLevel | null,
  ): Promise<void> {
    return this.mutate(id, (current) => ({
      ...current,
      tool_output_cap_level: value,
    })).then(() => undefined);
  }

  setLastResponseState(
    id: SessionId | string,
    responseId: string | null,
    messageCount: number | null,
  ): Promise<void> {
    return this.mutate(id, (current) => ({
      ...current,
      last_response_id: responseId,
      last_response_message_count: messageCount,
    })).then(() => undefined);
  }

  markReviewedNow(id: SessionId | string): Promise<void> {
    return this.mutate(id, (current) => ({
      ...current,
      last_review_at: new Date().toISOString(),
    })).then(() => undefined);
  }

  setMemoryBoundary(id: SessionId | string, seq: number): Promise<void> {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      return Promise.reject(new TypeError('memory boundary must be a non-negative seq'));
    }
    return this.mutate(id, (current) => ({
      ...current,
      memory_distilled_seq: Math.max(current.memory_distilled_seq, seq),
    })).then(() => undefined);
  }

  getMemoryBoundary(id: SessionId | string): Promise<number> {
    return this.get(id).then((state) => state.memory_distilled_seq);
  }

  bumpMemoryAttempts(id: SessionId | string): Promise<void> {
    return this.mutate(id, (current) => ({
      ...current,
      memory_distill_attempts: current.memory_distill_attempts + 1,
    })).then(() => undefined);
  }

  resetMemoryAttempts(id: SessionId | string): Promise<void> {
    return this.mutate(id, (current) => ({
      ...current,
      memory_distill_attempts: 0,
    })).then(() => undefined);
  }

  getOrCreateCloudSessionId(id: SessionId | string): Promise<string> {
    return this.mutate(id, (current) => ({
      ...current,
      cloudcode_session_id: current.cloudcode_session_id ?? newSessionId(),
    })).then((state) => state.cloudcode_session_id!);
  }

  setConfigLock(
    id: SessionId | string,
    lock: Readonly<Record<string, JsonValue>> | null,
  ): Promise<void> {
    return this.mutate(id, (current) => ({
      ...current,
      config_lock: lock,
    })).then(() => undefined);
  }

  getConfigLock(
    id: SessionId | string,
  ): Promise<Readonly<Record<string, JsonValue>> | null> {
    return this.get(id).then((state) => state.config_lock);
  }

  setGroup(id: SessionId | string, groupId: string | null): Promise<void> {
    return this.mutate(id, (current) => ({
      ...current,
      group_id: groupId,
    })).then(() => undefined);
  }

  async stageAgentTransition(
    id: SessionId | string,
    nextAgent: string | null,
  ): Promise<FsPendingAgentTransition | null> {
    const session = await this.directory.requireEntry(id);
    const mapped = this.directory.map(session);
    const current = await this.get(id);
    if (mapped.agent === nextAgent) return current.pending_agent_transition;
    const fromAgent =
      current.pending_agent_transition?.fromAgent ?? mapped.agent;
    await this.directory.updateCoderMetadata(session.location, (metadata) => ({
      ...metadata,
      agent: nextAgent,
    }));
    if (fromAgent === nextAgent) {
      await this.mutate(id, (runtime) => ({
        ...runtime,
        pending_agent_transition: null,
      }));
      return null;
    }
    const event = await this.entities.create(id, 'events', {
      kind: 'agent_transition',
      data: {
        from_agent: fromAgent,
        to_agent: nextAgent,
        action: 'staged',
      },
    });
    const pending: FsPendingAgentTransition = {
      id: event.id,
      sessionId: session.session.id,
      fromAgent,
      toAgent: nextAgent,
      seq: event.seq,
      updatedAt: event.updated_at,
    };
    await this.mutate(id, (runtime) => ({
      ...runtime,
      pending_agent_transition: pending,
    }));
    return pending;
  }

  async consumeAgentTransition(
    id: SessionId | string,
  ): Promise<FsPendingAgentTransition | null> {
    const pending = (await this.get(id)).pending_agent_transition;
    if (!pending) return null;
    await this.mutate(id, (runtime) => ({
      ...runtime,
      pending_agent_transition: null,
    }));
    await this.entities.create(id, 'events', {
      kind: 'agent_transition',
      data: {
        transition_id: pending.id,
        from_agent: pending.fromAgent,
        to_agent: pending.toAgent,
        action: 'consumed',
      },
    });
    return pending;
  }

  async getToolPermissionMode(
    id: SessionId | string,
  ): Promise<'ask' | 'auto' | 'unrestricted' | null> {
    const entry = await this.directory.requireEntry(id);
    const state =
      entry.state ??
      this.directory.repository.readStateSync(entry.location);
    const mode = state.permissions.mode;
    return mode === 'ask' || mode === 'auto' || mode === 'unrestricted'
      ? mode
      : null;
  }

  setToolPermissionMode(
    id: SessionId | string,
    mode: 'ask' | 'auto' | 'unrestricted' | null,
  ): Promise<void> {
    return this.directory.runMutation(id, async () => {
      const entry = await this.directory.requireEntry(id);
      await this.directory.repository.updateState(entry.location, (state) => ({
        ...state,
        permissions: { ...state.permissions, mode },
      }));
    });
  }

  addToolPermissionGrant(
    id: SessionId | string,
    toolName: string,
  ): Promise<void> {
    return this.directory.runMutation(id, async () => {
      const entry = await this.directory.requireEntry(id);
      await this.directory.repository.updateState(entry.location, (state) => ({
        ...state,
        permissions: {
          ...state.permissions,
          grants: [...new Set([...strings(state.permissions.grants), toolName])],
        },
      }));
    });
  }

  setToolProfile(
    id: SessionId | string,
    profile: keyof typeof PROFILE_RANK,
  ): Promise<void> {
    return this.directory.runMutation(id, async () => {
      const entry = await this.directory.requireEntry(id);
      await this.directory.repository.updateState(entry.location, (state) => {
        const current =
          typeof state.tools.profile === 'string'
            ? state.tools.profile
            : null;
        if (
          current != null &&
          (PROFILE_RANK[current as keyof typeof PROFILE_RANK] ?? -1) >=
            PROFILE_RANK[profile]
        ) {
          return state;
        }
        return { ...state, tools: { ...state.tools, profile } };
      });
    });
  }

  mergeToolsetState(
    id: SessionId | string,
    patch: {
      visibleCap?: number | null;
    },
  ): Promise<void> {
    return this.directory.runMutation(id, async () => {
      const entry = await this.directory.requireEntry(id);
      await this.directory.repository.updateState(entry.location, (state) => {
        const current = toolsetFromState(state);
        const next: FsToolsetState = {
          v: 1,
          // Written by older runs (expand_toolset / runtime pins); preserved as is.
          extraTiers: current.extraTiers,
          pins: current.pins,
          visibleCap:
            Object.prototype.hasOwnProperty.call(patch, 'visibleCap')
              ? patch.visibleCap ?? null
              : current.visibleCap,
        };
        return {
          ...state,
          tools: { ...state.tools, toolset: toJsonValue(next) },
        };
      });
    });
  }
}
