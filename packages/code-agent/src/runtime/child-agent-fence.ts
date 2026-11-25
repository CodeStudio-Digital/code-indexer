/**
 * Fence of a child-agent session run: an AgentRun record in the child's own
 * bundle and a mutation fence whose authorized root is the run's working
 * directory (the parent's, inherited at creation). A violation, or losing the
 * run record, aborts this child run only.
 */
import { createHash } from 'node:crypto';
import type { SessionId } from '@mcp/session-storage';
import type { FsSessionStore, FsSubagentRunFence } from '@mcp/session-storage/fs-store/index.js';
import type { ChatUsage } from '../core/messages.js';
import { createMutationFenceAuthority } from '../core/mutation-fence.js';
import type { ToolMutationFence } from '../core/tool.js';
import type { ChildAgentRun } from './child-agent-run.js';

export type ChildAgentFenceStore = Pick<FsSessionStore, 'startSubagentRun' | 'assertSubagentRunFence' | 'completeSubagentRun'>;

export interface ChildAgentFenceInput {
  sessionId: SessionId;
  runId: string;
  run: ChildAgentRun;
  cwd: string;
  roots?: ReadonlyArray<{ rootPath: string; slug?: string; name?: string }>;
  externalRoots?: ReadonlyArray<{ rootPath: string; access?: 'read' | 'write' }>;
  unrestrictedFilesystemAccess?: () => boolean;
  provider: string;
  model: string;
  effort?: string | null;
  capabilities: readonly string[];
  onViolation(message: string): void;
  /** How often the run record is re-asserted; tests shorten it. */
  heartbeatMs?: number;
}

export interface ChildAgentFence {
  readonly mutationFence: ToolMutationFence;
  readonly record: FsSubagentRunFence;
  complete(input: { reason: string; turns: number; toolCalls: number; usage: ChatUsage; hasSummary: boolean }): Promise<void>;
  stop(): void;
}

export async function startChildAgentFence(store: ChildAgentFenceStore, input: ChildAgentFenceInput): Promise<ChildAgentFence> {
  const startedAt = Date.now();
  const record = await store.startSubagentRun({
    session_id: input.sessionId,
    run_id: input.runId,
    profile: input.run.profile.id,
    label: input.run.profile.defaultLabel,
    requested_provider: input.provider,
    requested_model: input.model,
    requested_reasoning_effort: input.effort ?? null,
    effective_provider: input.provider,
    effective_model: input.model,
    effective_reasoning_effort: input.effort ?? null,
    effective_capabilities: [...input.capabilities],
    environment_fingerprint: createHash('sha256').update(JSON.stringify({
      cwd: input.cwd,
      roots: input.roots?.map((root) => root.rootPath) ?? [],
      externalRoots: input.externalRoots?.map((root) => root.rootPath) ?? [],
      unrestrictedFilesystem: input.unrestrictedFilesystemAccess?.() === true,
    })).digest('hex'),
    policy_mode: input.run.readOnly ? 'child_session_read_only' : 'child_session',
    max_turns: 0,
    max_tool_calls: input.run.limits.maxToolCalls,
    timeout_ms: input.run.limits.timeoutMs,
    stall_ms: input.run.limits.stallMs,
  });

  // The durable assertion runs on a heartbeat; mutations check its last verdict.
  let revoked: Error | null = null;
  let violated = false;
  const heartbeat = setInterval(() => {
    store.assertSubagentRunFence(record).catch((error: unknown) => {
      revoked = error instanceof Error ? error : new Error(String(error));
    });
  }, Math.max(50, input.heartbeatMs ?? 5_000));
  heartbeat.unref?.();

  const mutationFence = createMutationFenceAuthority({
    mode: 'enforce',
    authorizedRoot: input.cwd,
    unrestrictedFilesystemAccess: input.run.readOnly ? undefined : input.unrestrictedFilesystemAccess,
    filesystemRoots: [
      ...(input.roots ?? []).map((root) => ({
        rootPath: root.rootPath,
        aliases: [root.slug, root.name].filter((alias): alias is string => !!alias),
        access: 'write' as const,
      })),
      ...(input.externalRoots ?? []).map((root) => ({ rootPath: root.rootPath, access: root.access })),
    ],
    assertLease: () => {
      if (revoked) throw new Error(`child run record is no longer current: ${(revoked as Error).message}`);
    },
    snapshot: () => ({
      environmentId: `environment:${record.run_id}`,
      environmentVersion: 1,
      workspaceLeaseId: `workspace-lease:${record.fence_token}`,
      workspaceLeaseVersion: 1,
      workspaceFencingEpoch: 1,
      ownerAgentRunId: record.run_id,
    }),
    onViolation: (error) => {
      if (violated) return;
      violated = true;
      input.onViolation(error.message);
    },
  });
  const stopLeaseMonitor = mutationFence.startLeaseMonitor?.() ?? (() => undefined);

  return {
    mutationFence,
    record,
    async complete({ reason, turns, toolCalls, usage, hasSummary }) {
      await store.completeSubagentRun({
        run_id: record.run_id,
        reason,
        turns,
        auto_continues: 0,
        tool_calls: toolCalls,
        logical_operations: 0,
        productive_operations: 0,
        paginate_calls: 0,
        duplicate_calls: 0,
        error_calls: 0,
        refused_calls: 0,
        elapsed_ms: Date.now() - startedAt,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        has_summary: hasSummary,
        fence: record,
      });
    },
    stop() {
      clearInterval(heartbeat);
      stopLeaseMonitor();
    },
  };
}
