/**
 * Controlled scheduler for Company-backed App Studio sessions.
 *
 * It never reads/writes Company Kanban. It reconciles persistent agent runs
 * against App work-item attempts and, while the Master is dormant, dispatches
 * one conflict-free ready wave from the authoritative App workflow.
 */
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { IMetaBusPublisher } from '@mcp/company/services/ports.js';
import type { AutonomyProvider } from '@mcp/company/services/autonomy/autonomy-provider.js';
import {
  isAutonomyActionAllowed,
  resolveAutonomy,
} from '@mcp/company/services/autonomy/autonomy-config.js';
import { getAppStudioStore } from '@mcp/company/tools/app-studio/store-binding.js';
import {
  dispatchReadyAppWork,
  reconcileAppWorkItemRuns,
  type AppCompanyDispatchHost,
} from '@mcp/company/tools/app-studio/company-dispatch.js';

const DEFAULT_TICK_MS = 10_000;

function tickMs(): number {
  const raw = Number(process.env.MCP_APP_STUDIO_SCHEDULER_TICK_MS);
  return Number.isFinite(raw) && raw >= 2_000 ? raw : DEFAULT_TICK_MS;
}

export interface AppStudioSchedulerDeps {
  ctx: SessionContext;
  host: AppCompanyDispatchHost;
  master: { readonly isAlive: boolean; notify(message: string): void };
  bus?: Pick<IMetaBusPublisher, 'publish'>;
  autonomy?: Pick<AutonomyProvider, 'get'>;
}

export class AppStudioScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly deps: AppStudioSchedulerDeps) {}

  start(): void {
    if (this.timer || !this.deps.ctx.capabilities.allowAppScheduler) return;
    if (this.deps.ctx.appStudioSessionId == null) {
      console.warn(
        `[company s=${this.deps.ctx.companySessionId}] App scheduler not started: no linked App session`,
      );
      return;
    }
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.tick().finally(() => { this.running = false; });
    }, tickMs());
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const appSessionId = this.deps.ctx.appStudioSessionId;
    if (appSessionId == null) return;
    const store = getAppStudioStore();
    const session = store ? await store.getSession(appSessionId) : null;
    if (!store || !session || session.company_session_id !== this.deps.ctx.companySessionId) return;

    const reconciled = await reconcileAppWorkItemRuns({
      store,
      session,
      getAgentRun: (id) => this.deps.ctx.companyFiles.getAgentRunSync(id),
    });
    if (reconciled.length > 0) {
      const needsAttention = reconciled.filter((change) => change.action !== 'recovered');
      this.publish('app_work_runs_reconciled', {
        count: reconciled.length,
        recovered: reconciled.length - needsAttention.length,
        needs_attention: needsAttention.length,
      });
      if (needsAttention.length > 0) {
        this.deps.master.notify(
          `[SYSTEM] ${needsAttention.length} App specialist run(s) require attention after reconciliation. ` +
          'Inspect app_get_state and recover or reassign the blocked cards.',
        );
        return;
      }
    }

    const autonomy = this.deps.autonomy
      ? this.deps.autonomy.get()
      : resolveAutonomy(null, process.env);
    if (!isAutonomyActionAllowed(autonomy, 'scheduler')) return;
    if (this.deps.master.isAlive) return;

    const results = await dispatchReadyAppWork({
      store,
      session,
      host: this.deps.host,
      source: 'scheduler',
      maxItems: 2,
    });
    const started = results.filter((result) =>
      result.outcome === 'spawned' || result.outcome === 'reused',
    );
    if (started.length > 0) {
      this.publish('app_scheduler_dispatched', {
        app_session_id: appSessionId,
        work_items: started.map((result) => ({
          id: result.workItemId,
          role: result.role,
          agent_run_id: result.companyAgentRunId,
        })),
      });
    }
  }

  private publish(event: string, data: Record<string, unknown>): void {
    try {
      this.deps.bus?.publish(event, { ...data, at: Date.now() });
    } catch {
      // Visibility must never break reconciliation/dispatch.
    }
  }
}
