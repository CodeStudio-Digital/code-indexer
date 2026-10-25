import { err, ok, type CoderTool } from '../core/tool.js';
import type { AgentMessage } from '../core/messages.js';
import { runSubagent } from './implement-subagent.js';
import { resolveMicroAgentProfile } from './micro-agent-profiles.js';
import { providerForProfile, effortForProfile } from './subagent-provider.js';
import type { SubagentDeps } from './subagent.js';

export interface ChatCheckpoint {
  actor: string;
  spawnId: string;
  chatKey?: string;
  profile: string;
  label: string;
  cwd: string;
  transcript: AgentMessage[];
  files?: string[];
  outcomeUnknown?: boolean;
  phase?: 'running' | 'complete';
  ownerPid?: number;
  workspaceReady?: boolean;
}

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
        const checkpoint = await store.files.get<ChatCheckpoint>('checkpoints', target.id);
        if (!checkpoint) return err('No retained checkpoint is available for this child');
        if (target.state === 'running' && checkpoint.phase === 'running') {
          let alive = false;
          if (checkpoint.ownerPid) { try { process.kill(checkpoint.ownerPid, 0); alive = true; } catch { /* abandoned executor */ } }
          if (alive) return ok('Child is already running; queued messages will arrive at its next turn');
        }
        if (checkpoint.outcomeUnknown) return err('Child has an uncertain tool effect; reconcile its outcome before continuing');
        if (checkpoint.cwd !== ctx.cwd) return err('Workspace changed since the checkpoint; reconcile before continuing');
        const profile = resolveMicroAgentProfile(checkpoint.profile);
        if (!profile) return err('Child profile is no longer available');
        const pending = (await store.pending(target.id)).filter(row => row.to === target.id && row.status === 'queued');
        if (!pending.some(row => row.kind !== 'notify')) return ok('No pending work requires resuming this child');
        const result = await runSubagent({ provider: await providerForProfile(deps, profile), tools: deps.parentTools,
          ctx, sessionId: ctx.sessionId, sessionStore: deps.sessionStore }, {
          systemPrompt: profile.systemPrompt, initialMessages: checkpoint.transcript,
          profile: profile.id, label: checkpoint.label, spawnId: checkpoint.spawnId, chatKey: checkpoint.chatKey,
          allowlist: profile.allowlist, maxTurns: 30, reasoningEffort: effortForProfile(deps, profile),
          pathScope: checkpoint.files, pathScopeMode: profile.pathScopeMode,
        });
        return { ...ok(result.finalText), subUsage: result.usage, isError: result.reason !== 'completed' };
      } catch (error) { return err(error instanceof Error ? error.message : String(error)); }
    },
  };
}
