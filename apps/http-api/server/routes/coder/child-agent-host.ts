/**
 * The app side of child-agent sessions: creates a child, starts its run in its
 * own worker when the tree admission lets it, frees the slot when the run
 * ends, stops a child and its descendants, resumes stops and queued trees at
 * boot, and waits for children without model rounds. The parent's worker
 * reaches it through ChildAgentPort; E6 adds the transport and the tools.
 */
import { classifyCoderTerminalOutcome, normalizeCoderTerminalSignal, asSessionId } from '@mcp/agent-runtime-contracts';
import { formatChatMessage, rootChatId, type ChatCollaborationStore, type ChatMessage } from '@mcp/session-storage/collaboration/store.js';
import { ChildAgentAdmission } from '@mcp/code-agent/runtime/child-agent-admission.js';
import { deliverChildAgentCompletions } from '@mcp/code-agent/runtime/child-agent-notices.js';
import { fileChildAgentQueue } from '@mcp/code-agent/runtime/child-agent-queue-store.js';
import { ChildAgentRunService, failureReason, type ChildAgentLauncher } from '@mcp/code-agent/runtime/child-agent-runs.js';
import { ChildAgentStops, type ChildAgentStopReason } from '@mcp/code-agent/runtime/child-agent-stop.js';
import { createChildAgentSession } from '@mcp/code-agent/runtime/child-agent-sessions.js';
import { mailboxQuestions, waitForChildAgents } from '@mcp/code-agent/runtime/child-agent-wait.js';
import { profileTargetsFromProviderStore } from '@mcp/code-agent/runtime/child-agent-session-run.js';
import type { ChildAgentPort } from '@mcp/code-agent/ports/child-agent-port.js';
import { addBusEventSink } from '../../../coder-bus.js';
import { getCoderWorkerPool } from '../../../sse/coderWorkerPoolSingleton.js';
import { acceptLocalCoderCommand, bindLocalCommandBus, terminalizeLocalCoderCommand } from '../../../control-plane-shadow.js';
import { resolveAgentSelection } from '../../../custom-agents.js';
import type { ServerDeps } from '../../deps.js';
import { childAgentAttention } from './child-agent-attention.js';
import { withSessionLock } from './sessionLock.js';

type ChildAgentPool = Pick<ReturnType<typeof getCoderWorkerPool>, 'getBus' | 'runFresh' | 'abort'>; // what the host drives

export interface ChildAgentHost extends ChildAgentPort {
  readonly service: ChildAgentRunService;
  /** Whether a child's run is live in the pool, and whether it is paused on an approval prompt. */
  isRunning(childId: string): boolean;
  awaitingApproval(childId: string): boolean;
  /** Sends the completion notices of ended background runs (all, or of `childIds`). */
  deliverCompletions(childIds?: readonly string[]): Promise<string[]>;
  /** Wakes a child-agent recipient of a message through its tree admission; null when it is not a child agent. */
  wake(message: ChatMessage): Promise<boolean | null>;
  /** The user's Stop, or the archive or deletion of `sessionId`: stops its child agents (and itself when it is one). */
  stopSession(sessionId: string, reason: Exclude<ChildAgentStopReason, 'stopped_by_parent'>): Promise<string[]>;
  /** Boot, before the trees resume: finishes the stops a previous run of the app began. */
  resumeStops(): Promise<number>;
}

export function createChildAgentHost(input: {
  deps: ServerDeps;
  mailbox: ChatCollaborationStore;
  project(id: number): { id: number; name: string; root_path: string; is_synthetic?: boolean | number } | null | undefined;
  validateModel?(provider: string, model: string): void;
  pool?: ChildAgentPool;
  /** Overridable for tests; the real local command admission otherwise. */
  accept?: typeof acceptLocalCoderCommand;
  bind?: typeof bindLocalCommandBus;
  terminalize?: typeof terminalizeLocalCoderCommand;
  resolveAgent?: (agent: string) => Pick<NonNullable<ReturnType<typeof resolveAgentSelection>>, 'baseAgentId' | 'selectionId'> | null;
  attention?: ReturnType<typeof childAgentAttention>;
}): ChildAgentHost {
  const { deps, mailbox } = input;
  const pool: ChildAgentPool = input.pool ?? getCoderWorkerPool();
  const accept = input.accept ?? acceptLocalCoderCommand;
  const bind = input.bind ?? bindLocalCommandBus;
  const terminalize = input.terminalize ?? terminalizeLocalCoderCommand;
  const resolveAgent = input.resolveAgent ?? ((agent: string) => resolveAgentSelection(deps.providerStore, agent));
  const attention = input.attention ?? childAgentAttention();
  const isRunning = (id: string) => { const bus = pool.getBus(asSessionId(id)); return !!bus && !bus.ended; };
  // The queue lives in the app's collaboration files: after creating a child,
  // the app never writes its bundle (its worker owns the writer), only reads it.
  const queue = fileChildAgentQueue(mailbox.files);
  const sessions = { ...pickChildReads(deps.sessionStore) };
  const admission = new ChildAgentAdmission({ sessions, queue, isRunning });
  let service: ChildAgentRunService;
  const stops = new ChildAgentStops({
    sessions, queue, files: mailbox.files, admission, isRunning,
    // Under the child's session lock, like its start: a start in progress finishes first and is then aborted.
    abort: (id) => withSessionLock(asSessionId(id), async () => { if (isRunning(id)) await pool.abort(asSessionId(id)); }),
    closeMailbox: (id) => mailbox.stopSession(id),
    pump: (id) => service.pump(id),
  });
  const deliverCompletions = (childIds?: readonly string[]) => deliverChildAgentCompletions({
    queue, sessions, refresh: (childId) => deps.sessionStore.refreshSession(childId), mailbox,
  }, childIds);

  const launcher: ChildAgentLauncher = {
    isRunning,
    start: ({ childId, task, startKey }) => withSessionLock(asSessionId(childId), async () => {
      if (isRunning(childId)) return;
      // Stopped between its admission and this start: it never runs.
      if ((await queue.get(childId)).stop_requested_at) { await admission.release(childId, 'stopped'); return; }
      const session = await deps.sessionStore.getSession(childId);
      if (!session) throw new Error(`Child agent ${childId} is unavailable`);
      const agent = resolveAgent(session.agent ?? 'explore');
      if (!agent) throw new Error(`Agent of child ${childId} is unavailable`);
      // The start key makes a re-delivered start an `existing` command: never two runs.
      const acceptance = await accept({
        store: deps.controlPlaneStore, sessionId: asSessionId(childId), kind: 'send_message',
        idempotencyKey: startKey, fingerprint: { childAgentStart: startKey },
        actor: { actorId: rootChatId(session.parent_session_id ?? childId), actorType: 'agent', source: 'http' },
        createRun: true, role: agent.baseAgentId, agentDefinitionId: agent.selectionId,
        requestedProvider: session.provider, requestedModel: session.model,
        requestedCapabilityProfile: 'navigate', requestedPreset: 'standard',
      });
      if (acceptance?.outcome === 'existing') {
        const status = acceptance.commandStatus;
        // Accepted before and already over: the run ended while nobody listened.
        if (status === 'succeeded' || status === 'failed' || status === 'cancelled') await service.ended(childId, status);
        // Accepted before a restart but not live: whether it ran is unknown, so it
        // never runs again; the slot is freed and the wait reports the failure.
        else if (!isRunning(childId)) await service.ended(childId, 'start_unknown');
        return;
      }
      if (acceptance?.outcome !== 'accepted') throw new Error(`Child agent ${childId} start was not admitted`);
      const bus = await pool.runFresh(asSessionId(childId), {
        userMessage: task, agent: agent.baseAgentId, agentSelectionId: agent.selectionId,
        thinking: session.thinking_enabled === true, controlPlaneRunContext: acceptance.runContext,
      });
      if (!await bind(deps.controlPlaneStore, acceptance, bus.busId)) {
        bus.ctrl.abort(new Error('child-agent-command-binding-failed'));
        throw new Error('Failed to bind child agent command');
      }
      const stopSink = addBusEventSink(bus, (event) => {
        if (event.event === 'tool_approval_request') attention.request(childId, session.parent_session_id ?? childId, session.title, session.project_id ?? null);
        if (event.event === 'tool_approval_resolved') attention.resolve(childId);
      });
      let settled = false;
      const finish = () => {
        if (settled || !bus.ended) return;
        settled = true;
        stopSink();
        attention.resolve(childId); // a prompt left open ends with the run
        const end = bus.endReason ?? { event: 'error' as const, data: { reason: 'missing-bus-outcome' } };
        const normalized = normalizeCoderTerminalSignal(end.event, end.data as Record<string, unknown>);
        const terminal = classifyCoderTerminalOutcome({ event: normalized.event, ...normalized.data });
        const status = terminal.classification === 'completed' ? 'succeeded' : terminal.classification === 'cancelled' ? 'cancelled' : 'failed';
        // Why it ended badly goes to the app log and, through the queue entry, to the waiting parent.
        const detail = status === 'failed' ? failureReason(terminal.reason, terminal.message) : undefined;
        if (detail) console.warn(`[child-agent] run of ${childId} failed: ${detail}`);
        void terminalize(deps.controlPlaneStore, acceptance, { status, reason: terminal.reason })
          .finally(() => service.ended(childId, status, detail))
          .then(() => deliverCompletions([childId]))
          .catch((error) => console.warn('[child-agent] end of run failed:', error));
      };
      if (bus.ended) finish(); else bus.endListeners.add(finish);
    }),
  };
  service = new ChildAgentRunService({ sessions, admission, launcher });

  return {
    service,
    isRunning,
    awaitingApproval: (childId) => attention.awaiting(childId),
    deliverCompletions,
    async wake(message) {
      const recipient = await mailbox.participant(message.to);
      const child = recipient ? await deps.sessionStore.getChildAgentSession(recipient.sessionId) : null;
      if (!child) return null;
      // A stopped child is never woken by a message: only its parent's explicit new start runs it again.
      if (child.is_archived || isRunning(child.id) || (await queue.get(child.id)).stop_requested_at) return false;
      if ((await mailbox.get(message.id)).status !== 'queued') return false;
      // Nobody waits on a run a message started: its end reaches the parent as a notice.
      const entry = await service.request(child.id, `<agent_message>\n${formatChatMessage(message)}\n</agent_message>`, { background: true });
      return entry.state === 'admitted';
    },
    async create(parentId, request) {
      const created = await createChildAgentSession({
        sessions: deps.sessionStore, project: input.project, validateModel: input.validateModel,
        resolveProfileTarget: profileTargetsFromProviderStore(deps.config.dbPath),
      }, parentId, request);
      // Parent and child share a mailbox link: the child can ask, the parent can answer.
      for (const [id, title] of [[parentId, parentId], [created.child.id, request.title]] as const) {
        if (!await mailbox.participant(rootChatId(id))) await mailbox.registerRoot(id, title);
      }
      await mailbox.linkSessions(parentId, created.child.id, true);
      // Asking again for an existing child is the parent's explicit new start, also after a stop.
      if (request.start !== false) await service.request(created.child.id, request.task, { background: request.wait === false, restart: !created.created });
      return { child: (await deps.sessionStore.getChildAgentSession(created.child.id)) ?? created.child, created: created.created };
    },
    async stop(callerId, chatIds) {
      const stopped = await stops.stopByAncestor(callerId, chatIds);
      attention.stopped(callerId, stopped, 'stopped_by_parent');
      return { stopped };
    },
    async stopSession(sessionId, reason) {
      const stopped = await stops.stopSession(sessionId, reason);
      attention.stopped(sessionId, stopped.filter((id) => id.toLowerCase() !== sessionId.toLowerCase()), reason);
      return stopped;
    },
    resumeStops: () => stops.resume(),
    wait: (request) => waitForChildAgents({ sessions, queue, refresh: (childId) => deps.sessionStore.refreshSession(childId),
      pendingQuestion: mailboxQuestions(mailbox), awaitingApproval: (childId) => attention.awaiting(childId) }, request),
  };
}

/** The read-only part of the session store the child-agent machinery uses. */
function pickChildReads(store: ServerDeps['sessionStore']) {
  return {
    getChildAgentSession: (id: string) => store.getChildAgentSession(id),
    listChildAgentSessions: (id: string) => store.listChildAgentSessions(id),
    listSubagentRuns: (id: string, offset: number, limit: number) => store.listSubagentRuns(id, offset, limit),
    refreshSession: (id: string) => store.refreshSession(id),
  };
}
