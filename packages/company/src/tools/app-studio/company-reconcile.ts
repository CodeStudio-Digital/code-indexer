import type {
  AppStudioSession,
  AppStudioStore,
  AppStudioWorkItemRun,
} from '@mcp/store/app-studio-store.js';

type ReconcileAction = 'blocked' | 'cancelled' | 'recovered';

export async function reconcileAppWorkItemRuns(args: {
  store: AppStudioStore;
  session: AppStudioSession;
  getAgentRun: (id: string) => { status: string; status_message?: string | null } | null;
}): Promise<Array<{ run: AppStudioWorkItemRun; action: ReconcileAction }>> {
  const changes: Array<{ run: AppStudioWorkItemRun; action: ReconcileAction }> = [];
  const activeRuns = (await args.store.listWorkItemRuns(args.session.id, { limit: 1_000 }))
    .filter((run) => ['claimed', 'running', 'waiting', 'paused'].includes(run.status));
  for (const run of activeRuns) {
    const item = await args.store.getWorkItem(args.session.id, run.work_item_id);
    if (run.company_agent_run_id == null) {
      const recoveryMessage = 'Recovered unbound App dispatch claim; the same attempt is ready for redispatch.';
      if (!item || ['done', 'stale', 'cancelled'].includes(item.status)) {
        await args.store.updateWorkItemRunStatus(run.id, 'cancelled', { statusMessage: recoveryMessage });
        changes.push({ run, action: 'cancelled' });
        continue;
      }
      if (run.status === 'claimed' && run.status_message === recoveryMessage) continue;
      await args.store.updateWorkItemRunStatus(run.id, 'claimed', { statusMessage: recoveryMessage });
      if (item.status === 'running') {
        await args.store.setWorkItemStatus(args.session.id, run.work_item_id, 'backlog');
        await args.store.refreshReadyWorkItems(args.session.id);
      }
      await args.store.appendEvent(
        args.session.id,
        'agents.unbound_claim_recovered',
        'work_item_run',
        String(run.id),
        JSON.stringify({ work_item_id: run.work_item_id, attempt: run.attempt }),
        `app-unbound-claim-recovered:${run.id}`,
      );
      changes.push({ run, action: 'recovered' });
      continue;
    }
    const agent = args.getAgentRun(run.company_agent_run_id);
    if (!agent || !item || item.status !== 'running') continue;
    if (agent.status === 'waiting' || agent.status === 'completed') {
      const reason = 'Specialist finished without recording App Studio evidence.';
      await args.store.updateWorkItemRunStatus(run.id, 'blocked', { statusMessage: reason });
      await args.store.setWorkItemStatus(args.session.id, run.work_item_id, 'blocked', { blockedReason: reason });
      await args.store.appendEvent(
        args.session.id,
        'agents.run_without_evidence',
        'work_item_run',
        String(run.id),
        JSON.stringify({
          work_item_id: run.work_item_id,
          company_agent_run_id: run.company_agent_run_id,
          agent_status: agent.status,
        }),
        `app-run-without-evidence:${run.id}`,
      );
      changes.push({ run, action: 'blocked' });
    } else if (agent.status === 'interrupted') {
      const reason = agent.status_message?.trim() || `Specialist run ended with status ${agent.status}.`;
      await args.store.updateWorkItemRunStatus(run.id, 'paused', { statusMessage: reason });
      await args.store.setWorkItemStatus(args.session.id, run.work_item_id, 'blocked', { blockedReason: reason });
      await args.store.appendEvent(
        args.session.id,
        'agents.run_recovered_after_restart',
        'work_item_run',
        String(run.id),
        JSON.stringify({
          work_item_id: run.work_item_id,
          company_agent_run_id: run.company_agent_run_id,
          agent_status: agent.status,
          reason,
        }),
        `app-run-recovery:${run.id}:interrupted`,
      );
      changes.push({ run, action: 'blocked' });
    } else if (['error', 'aborted'].includes(agent.status)) {
      const reason = agent.status_message?.trim() || `Specialist run ended with status ${agent.status}.`;
      await args.store.updateWorkItemRunStatus(run.id, agent.status as 'error' | 'aborted', { statusMessage: reason });
      await args.store.setWorkItemStatus(args.session.id, run.work_item_id, 'blocked', { blockedReason: reason });
      await args.store.appendEvent(
        args.session.id,
        'agents.run_failed',
        'work_item_run',
        String(run.id),
        JSON.stringify({
          work_item_id: run.work_item_id,
          company_agent_run_id: run.company_agent_run_id,
          agent_status: agent.status,
          reason,
        }),
        `app-run-terminal:${run.id}:${agent.status}`,
      );
      changes.push({ run, action: 'blocked' });
    }
  }
  return changes;
}
