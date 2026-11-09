import { createHash } from 'node:crypto';
import type { ChatCheckpoint } from './chat-checkpoint.js';
import type { ChatCollaborationStore } from '@mcp/session-storage/collaboration/store.js';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';

/** Migrate only configuration proven by a matching terminal AgentRun. Legacy
 * files without that evidence remain readable but cannot silently execute. */
export async function migrateChatCheckpoint(checkpoint: ChatCheckpoint, sessionId: string,
  mailbox: ChatCollaborationStore, sessions?: FsSessionStore): Promise<ChatCheckpoint> {
  if (checkpoint.execution) return checkpoint;
  if (!sessions || checkpoint.phase !== 'complete' || checkpoint.outcomeUnknown || await mailbox.epoch(sessionId) !== 0) return checkpoint;
  const runs = (await sessions.listSubagentRuns(sessionId, 0, 1000)).items.filter(run =>
    (checkpoint.fence ? run.run_id === checkpoint.fence.run_id : run.spawn_id === checkpoint.spawnId)
    && run.profile === checkpoint.profile);
  const run = runs.sort((a, b) => b.seq - a.seq)[0];
  if (!run || run.status !== 'completed' || /unknown/i.test(run.reason ?? '') || !run.effective_provider
    || !run.effective_model || !run.worker_instance_id || !Number.isInteger(run.max_turns)) return checkpoint;
  const digest = createHash('sha256').update(JSON.stringify(checkpoint)).digest('hex');
  await mailbox.files.insert('checkpoints', `legacy-backup:${checkpoint.actor}:${digest}`, checkpoint);
  const migrated: ChatCheckpoint = { ...checkpoint, schemaVersion: 3, execution: {
    schemaVersion: 1, provider: run.effective_provider, model: run.effective_model,
    effort: run.effective_reasoning_effort ?? undefined, maxTurns: run.max_turns,
    limits: { maxToolCalls: run.max_tool_calls ?? undefined, timeoutMs: run.timeout_ms ?? undefined, stallMs: run.stall_ms ?? undefined },
    profile: run.profile, workspace: checkpoint.cwd, inputDigest: `legacy-retained:${digest}`,
    policyVersion: 'legacy-migrated-from-agent-run', runId: run.run_id, instanceId: run.worker_instance_id, epoch: 0,
  } };
  await mailbox.files.put('checkpoints', checkpoint.actor, migrated);
  return migrated;
}
