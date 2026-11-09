import { err, ok, type CoderTool } from '../core/tool.js';
import type { ChatCheckpoint } from '../runtime/chat-checkpoint.js';
import { runSubagent } from './implement-subagent.js';
import { resolveMicroAgentProfile } from './micro-agent-profiles.js';
import { providerForProfile } from './subagent-provider.js';
import type { SubagentDeps } from './subagent.js';
import { migrateChatCheckpoint } from '../runtime/chat-checkpoint-migration.js';

export type { ChatCheckpoint } from '../runtime/chat-checkpoint.js';

export function buildResumeChatTool(deps: SubagentDeps): CoderTool {
  return {
    name: 'resume_chat', source: 'native', mutates: false, riskLevel: 'read', effectBoundary: 'control', parallelSafe: false,
    description: 'Resume an idle child chat with its retained context and queued requests. Use its exact list_chats ID. Completed work is preserved; uncertain effects must be reconciled first. Running children receive messages automatically.',
    timeoutMs: Infinity,
    parameters: { type: 'object', properties: { chat_id: { type: 'string' } }, required: ['chat_id'], additionalProperties: false },
    handler: async (args, ctx) => {
      if (!ctx.collaboration || !ctx.sessionId) return err('No collaboration context');
      const { store, actor } = ctx.collaboration;
      try {
        const target = await store.requireParticipant(String(args.chat_id));
        if (target.parentId !== actor || target.sessionId !== ctx.sessionId) return err('Only the owning coordinator can resume a child');
        if (target.state === 'stopped') return err('Child was stopped; do not restart it automatically');
        let checkpoint = await store.files.get<ChatCheckpoint>('checkpoints', target.id);
        if (!checkpoint) return err('No retained checkpoint is available for this child');
        if (checkpoint.execution && checkpoint.execution.epoch !== await store.epoch(ctx.sessionId)) return err('target_generation_changed: this checkpoint belongs to an earlier stopped generation');
        if (checkpoint.phase === 'committing') {
          const row = deps.sessionStore && checkpoint.execution
            ? (await deps.sessionStore.listSubagentRuns(ctx.sessionId, 0, 1000)).items.find(row => row.run_id === checkpoint!.execution!.runId) : null;
          if (!row || row.status !== 'completed' || row.reason === 'outcome_unknown') return err('effect_unknown: checkpoint exists but its terminal receipt is not confirmed');
          checkpoint = { ...checkpoint, phase: 'complete' };
          await store.files.put('checkpoints', target.id, checkpoint);
        }
        if (target.state === 'running' && checkpoint.phase === 'running') {
          if (checkpoint.fence && deps.sessionStore) {
            try {
              await deps.sessionStore.assertSubagentRunFence(checkpoint.fence);
              return ok('Child has a valid executor lease; queued messages will arrive at its next turn');
            } catch { /* Expired/foreign lease is not evidence of an effect outcome. */ }
          }
          return err('effect_unknown: executor lease is unavailable; reconcile the durable AgentRun before resuming. PID is not proof of ownership.');
        }
        checkpoint = await migrateChatCheckpoint(checkpoint, ctx.sessionId, store, deps.sessionStore);
        if (!checkpoint.execution) return err('legacy_checkpoint: original configuration cannot be proven from the durable AgentRun; preserve this checkpoint and reconcile it before resuming');
        if (checkpoint.outcomeUnknown) return err('Child has an uncertain tool effect; reconcile its outcome before continuing');
        if (checkpoint.cwd !== ctx.cwd) return err('Workspace changed since the checkpoint; reconcile before continuing');
        const profile = resolveMicroAgentProfile(checkpoint.profile);
        if (!profile) return err('Child profile is no longer available');
        const provider = await providerForProfile(deps, profile);
        if (provider.name !== checkpoint.execution.provider || provider.model !== checkpoint.execution.model) {
          return err(`configuration_changed: retained child used ${checkpoint.execution.provider}/${checkpoint.execution.model}; restore that target or explicitly migrate the checkpoint`);
        }
        const pending = (await store.pending(target.id)).filter(row => row.to === target.id && row.status === 'queued');
        if (!pending.some(row => row.kind !== 'notify')) return ok('No pending work requires resuming this child');
        const result = await runSubagent({ provider, tools: deps.parentTools,
          ctx, sessionId: ctx.sessionId, sessionStore: deps.sessionStore }, {
          systemPrompt: profile.systemPrompt, initialMessages: checkpoint.transcript,
          profile: profile.id, label: checkpoint.label, spawnId: checkpoint.spawnId, chatKey: checkpoint.chatKey,
          allowlist: profile.allowlist, maxTurns: checkpoint.execution.maxTurns,
          reasoningEffort: checkpoint.execution.effort, limits: checkpoint.execution.limits,
          pathScope: checkpoint.files, pathScopeMode: profile.pathScopeMode,
        });
        return { ...ok(result.finalText), subUsage: result.usage, isError: result.reason !== 'completed',
          structuredData: { result: result.workResult, execution: result.execution, integration: result.integration } };
      } catch (error) { return err(error instanceof Error ? error.message : String(error)); }
    },
  };
}
