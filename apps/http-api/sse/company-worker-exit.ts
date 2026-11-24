import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import { releaseSessionWriterLeaseForOwner, type CompanySessionId } from '@mcp/session-storage';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';

const activeAgentStates = new Set(['running', 'working', 'waiting_plan', 'waiting_question', 'waiting_tasks', 'reviewing']);
export type CompanyWorkerExitHandler = (
  id: CompanySessionId, ownerId: string, publish: (event: string, data: Record<string, unknown>) => void,
) => Promise<void>;

/** Called only after the worker thread exited, before this Company can acquire another worker. */
export async function interruptCompanyWorker(
  store: FsSessionStore, ...[id, ownerId, publish]: Parameters<CompanyWorkerExitHandler>
): Promise<void> {
  await store.discoverNewSessions();
  const files = new CompanySessionFiles({ companySessionId: id, sessionStore: store });
  // Operational rows also use the Company bundle writer. Release this generation's
  // lease before the host attempts its first status update.
  await releaseSessionWriterLeaseForOwner({ bundlePath: files.location.bundle_path, ownerId });
  const runs = files.listAgentRunsSync();
  const liveChats = new Set(runs.filter(run => !run.archive_id && activeAgentStates.has(run.status)).map(run => run.coder_session_id));
  const message = 'Company worker stopped. Resume this agent to continue its task.';
  const failures: unknown[] = [];
  for (const run of runs) {
    if (run.archive_id || !activeAgentStates.has(run.status)) continue;
    try {
      await files.updateAgentRunStatus(run.id, 'interrupted', message);
      publish('agent_status', { agentRunId: run.id, role: run.role, status: 'interrupted', coderSessionId: run.coder_session_id, message });
    } catch (error) { failures.push(error); }
  }
  for (const entry of store.catalog.entriesSnapshot()) {
    const session = entry.session;
    const company = String(session.id) === String(id);
    if (!company && !(session.kind === 'coder' && (session.metadata.company_session_id === id || session.metadata.companySessionId === id || liveChats.has(session.id)))) continue;
    try {
      const released = !company && await releaseSessionWriterLeaseForOwner({ bundlePath: entry.location.bundle_path, ownerId });
      if (!company && !released && !liveChats.has(session.id)) continue;
      const status = store.repository.readStateSync(entry.location).status;
      if (['running', 'working', 'in_progress'].includes(status)) {
        if (company) await files.updateSessionStatus('interrupted');
        else {
          try { await store.updateSessionStatus(session.id, 'interrupted'); }
          finally { await store.repository.closeSession(entry.location); }
        }
      }
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Could not reconcile all Company worker sessions');
}
