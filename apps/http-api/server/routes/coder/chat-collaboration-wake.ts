import { asSessionId, classifyCoderTerminalOutcome, normalizeCoderTerminalSignal } from '@mcp/agent-runtime-contracts';
import { ChatCollaborationStore, formatChatMessage, rootChatId, type ChatMessage } from '@mcp/session-storage/collaboration/store.js';
import type { ServerDeps } from '../../deps.js';
import type { CoderRuntime } from './state.js';
import { withSessionLock } from './sessionLock.js';
import { resolveAgentSelection } from '../../../custom-agents.js';
import { getCoderWorkerPool } from '../../../sse/coderWorkerPoolSingleton.js';
import { acceptLocalCoderCommand, bindLocalCommandBus, terminalizeLocalCoderCommand } from '../../../control-plane-shadow.js';
import type { SessionNetwork } from '@mcp/code-agent/runtime/session-network.js';
import { reserveNetworkWake } from '@mcp/code-agent/runtime/session-network-events.js';
import type { ChatScheduler } from '@mcp/code-agent/runtime/chat-scheduler.js';

/** Uses the same durable admission and exclusive session writer as human sends. */
export async function wakeCollaboratingChat(deps: ServerDeps, runtime: CoderRuntime, mailbox: ChatCollaborationStore, message: ChatMessage, network?: SessionNetwork, scheduler?: ChatScheduler): Promise<boolean> {
  const recipient = await mailbox.requireParticipant(message.to);
  const sender = await mailbox.requireParticipant(message.from);
  const root = await mailbox.participant(rootChatId(recipient.sessionId));
  if (root?.state === 'stopped' || !await mailbox.connected(sender.sessionId, recipient.sessionId)) return false;
  const id = asSessionId(recipient.sessionId);
  return withSessionLock(id, async () => {
    if ((await mailbox.participant(rootChatId(id)))?.state === 'stopped' || (await mailbox.get(message.id)).status !== 'queued'
      || !await mailbox.currentGeneration(message)) return false;
    if (scheduler && !await scheduler.canWake(message.id, message.references)) return false;
    const pool = getCoderWorkerPool();
    const active = pool.getBus(id);
    if (active && !active.ended) return false;
    const session = network ? await network.session(id).catch(() => null) : await deps.sessionStore.getSession(id);
    if (!session || await runtime.findPendingInteraction(id)) return false;
    const agent = resolveAgentSelection(deps.providerStore, session.agent ?? 'explore');
    if (!agent) return false;
    if (network && !await reserveNetworkWake(network, id, message.id)) return false;
    const acceptance = await acceptLocalCoderCommand({
      store: deps.controlPlaneStore, sessionId: id, kind: 'send_message',
      idempotencyKey: `collaboration:${message.id}`, fingerprint: { collaborationMessageId: message.id, recipient: message.to },
      actor: { actorId: message.from, actorType: 'agent', source: 'http' },
      createRun: true, role: agent.baseAgentId, agentDefinitionId: agent.selectionId,
      requestedProvider: session.provider, requestedModel: session.model,
      requestedCapabilityProfile: 'navigate', requestedPreset: session.execution_mode_override ?? 'standard',
    });
    if (acceptance?.outcome === 'existing') {
      if (/effect_unknown/.test(acceptance.commandReasonCode ?? '')) { await scheduler?.reconcile(message.id, 'unknown'); return false; }
      const status = acceptance.commandStatus;
      if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
        await scheduler?.reconcile(message.id, status);
        if (!recipient.parentId) await mailbox.acknowledge(recipient.id, message.id);
        return true;
      }
      await scheduler?.reconcile(message.id, 'unknown');
      return false;
    }
    if (acceptance?.outcome !== 'accepted') return false;
    // resume_chat is gone outside Company: an earlier in-process child can no longer be continued.
    const childInstruction = recipient.parentId
      ? `This message is for ${recipient.id}, an earlier subagent of yours that can no longer be resumed. Answer with send_chat_message if needed; delegate new work with create_chat. Do not repeat completed work.\n`
      : '';
    let spawnedBus: ReturnType<typeof pool.getBus> | undefined;
    try {
      if (!await mailbox.currentGeneration(message) || (scheduler && !await scheduler.canWake(message.id, message.references))) {
        await terminalizeLocalCoderCommand(deps.controlPlaneStore, acceptance, { status: 'cancelled', reason: 'collaboration-generation-changed' });
        return false;
      }
      const bus = await pool.runFresh(id, {
        userMessage: `<agent_message>\n${childInstruction}${formatChatMessage(message)}\n</agent_message>`,
        agent: agent.baseAgentId, agentSelectionId: agent.selectionId,
        customAgentPrompt: agent.custom?.prompt, allowedToolNames: agent.custom?.toolNames ?? undefined,
        initialPinnedTools: agent.custom?.pinnedToolNames, initialToolTiers: agent.custom?.requiredToolTiers,
        initialVisibleToolCap: agent.custom?.visibleToolCap ?? undefined,
        thinking: session.thinking_enabled === true,
        controlPlaneRunContext: acceptance.runContext,
      });
      spawnedBus = bus;
      if (!await bindLocalCommandBus(deps.controlPlaneStore, acceptance, bus.busId)) {
        bus.ctrl.abort(new Error('collaboration-command-binding-failed'));
        throw new Error('Failed to bind collaboration command');
      }
      if (scheduler) {
        await scheduler.started(message.id, bus.busId);
        const finishSchedule = () => {
          const end = bus.endReason ?? { event: 'error' as const, data: { reason: 'missing-bus-outcome' } };
          const normalized = normalizeCoderTerminalSignal(end.event, end.data as Record<string, unknown>);
          const terminal = classifyCoderTerminalOutcome({ event: normalized.event, ...normalized.data });
          void scheduler.reconcile(message.id, terminal.classification === 'completed' ? 'succeeded'
            : terminal.classification === 'cancelled' ? 'cancelled' : 'failed')
            .catch(error => console.warn('[chat-scheduler] terminal receipt failed:', error));
        };
        if (bus.ended) finishSchedule(); else bus.endListeners.add(finishSchedule);
      }
      if (!acceptance.runContext) {
        let settled = false;
        const finish = async () => {
          if (settled || !bus.ended) return;
          settled = true;
          const end = bus.endReason ?? { event: 'error' as const, data: { reason: 'missing-bus-outcome' } };
          const normalized = normalizeCoderTerminalSignal(end.event, end.data as Record<string, unknown>);
          const terminal = classifyCoderTerminalOutcome({ event: normalized.event, ...normalized.data });
          await terminalizeLocalCoderCommand(deps.controlPlaneStore, acceptance, {
            status: terminal.classification === 'completed' ? 'succeeded' : terminal.classification === 'cancelled' ? 'cancelled' : 'failed', reason: terminal.reason,
          });
        };
        const finalize = () => { void finish().catch(error => console.warn('[chat-collaboration] terminal receipt failed:', error)); };
        if (bus.ended) finalize(); else bus.endListeners.add(finalize);
      }
      if (!recipient.parentId) await mailbox.acknowledge(recipient.id, message.id);
      return true;
    } catch (error) {
      const live = spawnedBus;
      if (live && !live.ended) live.ctrl.abort(new Error('collaboration-admission-unconfirmed'));
      await scheduler?.reconcile(message.id, 'unknown');
      await terminalizeLocalCoderCommand(deps.controlPlaneStore, acceptance, { status: 'failed', reason: 'effect_unknown: collaboration-wake-failed' });
      throw error;
    }
  });
}

export async function startCollaborationWakeService(mailbox: ChatCollaborationStore,
  wake: (message: ChatMessage) => Promise<boolean>, beforeScan?: () => Promise<void>): Promise<() => Promise<void>> {
  await mailbox.init();
  let stopped = false;
  let dirty = false;
  let running: Promise<void> | null = null;
  const recent = new Map<string, number[]>();
  const scan = async () => {
    await beforeScan?.();
    for (const message of await mailbox.pending(undefined, { wakeOnly: true })) {
      if (stopped) return;
      if (message.kind === 'notify' || message.status !== 'queued') continue;
      const target = await mailbox.participant(message.to);
      if (!target || target.state === 'stopped') continue;
      const times = (recent.get(target.sessionId) ?? []).filter(at => at > Date.now() - 60_000);
      if (times.length >= 8) continue;
      try {
        if (await wake(message)) { times.push(Date.now()); recent.set(target.sessionId, times); }
      } catch (error) { console.warn('[chat-collaboration] wake failed:', error); }
    }
  };
  const schedule = () => {
    if (stopped) return;
    dirty = true;
    if (running) return;
    running = (async () => {
      while (dirty && !stopped) { dirty = false; await scan(); }
    })().catch(error => console.warn('[chat-collaboration] scan failed:', error)).finally(() => { running = null; });
  };
  const unsubscribe = mailbox.subscribe(schedule);
  const recovery = setInterval(schedule, 15_000); recovery.unref();
  schedule();
  return async () => { stopped = true; unsubscribe(); clearInterval(recovery); await running; };
}
