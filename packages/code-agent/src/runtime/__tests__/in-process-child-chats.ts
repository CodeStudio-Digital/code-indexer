/**
 * Test helper: an in-process ChildChatPort over the child-agent runtime, as
 * the app runs it (queue in the app's files, tree admission, durable wait)
 * with the app's own store instance, installed as this process's port. `run`
 * plays the child's worker (the real runCoder in the integration test).
 */
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { rootChatId, type ChatCollaborationStore } from '@mcp/session-storage/collaboration/store.js';
import { setChildChatPort, type ChildChatPort } from '../../ports/child-chat-port.js';
import { ChildAgentAdmission } from '../child-agent-admission.js';
import { fileChildAgentQueue } from '../child-agent-queue-store.js';
import { ChildAgentRunService, failureReason } from '../child-agent-runs.js';
import { createChildAgentSession } from '../child-agent-sessions.js';
import { waitForChildAgents } from '../child-agent-wait.js';

export function buildInProcessChildChats(input: {
  app: FsSessionStore;
  mailbox: ChatCollaborationStore;
  project(id: number): { id: number; name: string; root_path: string } | null;
  run(childId: string, task: string): Promise<{ reason: string }>;
}): ChildChatPort & { drain(): Promise<void> } {
  const { app, mailbox } = input;
  const queue = fileChildAgentQueue(mailbox.files);
  const reads = {
    getChildAgentSession: (id: string) => app.getChildAgentSession(id),
    listChildAgentSessions: (id: string) => app.listChildAgentSessions(id),
    listSubagentRuns: (id: string, offset: number, limit: number) => app.listSubagentRuns(id, offset, limit),
    refreshSession: (id: string) => app.refreshSession(id),
  };
  const live = new Set<string>();
  const runs: Promise<void>[] = [];
  const isRunning = (id: string) => live.has(id);
  const service: ChildAgentRunService = new ChildAgentRunService({ sessions: reads, admission: new ChildAgentAdmission({ sessions: reads, queue, isRunning }),
    launcher: { isRunning, async start({ childId, task }) {
      live.add(childId);
      // A run that rejects is logged and its reason reaches the waiting parent, as the app does.
      const run = input.run(childId, task).then((outcome) => ({ reason: outcome.reason, detail: undefined as string | undefined }), (error: unknown) => {
        console.error(`[test child-agent] run of ${childId} rejected:`, error);
        return { reason: 'failed', detail: failureReason('run_failed', error) };
      }).then(({ reason, detail }) => { live.delete(childId); return service.ended(childId, reason, detail); });
      runs.push(run);
    } } });
  const port: ChildChatPort = {
    async create(callerId, request) {
      const { child, created, target } = await createChildAgentSession({ sessions: app, project: input.project }, callerId, request);
      for (const [id, title] of [[callerId, callerId], [child.id, request.title]] as const) {
        if (!await mailbox.participant(rootChatId(id))) await mailbox.registerRoot(id, title);
      }
      await mailbox.linkSessions(callerId, child.id, true);
      await service.request(child.id, request.task, { background: request.wait === false });
      return { chatId: child.id, title: request.title, profile: child.profile ?? request.profile, readOnly: child.read_only, created, target };
    },
    wait: (_callerId, request, signal) => waitForChildAgents({ sessions: reads, queue, refresh: (id) => app.refreshSession(id) },
      { ...request, pollMs: 50, signal }),
    async message(_callerId, chatId, message) {
      const entry = await service.requestNext(chatId, message.message, { background: message.background }, 30_000);
      if (!entry) throw new Error(`chat ${chatId} is still running`);
      return { since: entry.requested_at! };
    },
    stop: async () => { throw new Error('not used here'); },
    list: async () => [],
  };
  setChildChatPort(port);
  return { ...port, async drain() { for (const run of runs) await run; } };
}
