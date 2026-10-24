import type { CompanyStore } from '@mcp/store/company-store.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import {
  asCompanySessionId,
  type CompanySessionId,
} from '@mcp/session-storage';
import { createBus, addBusEventSink, type CoderRunBus } from '@apps/http-api/coder-bus.js';

import { SessionContext } from '../services/SessionContext.js';
import { MetaBusPublisher } from '../services/MetaBusPublisher.js';
import { MetaBusWirer } from '../services/MetaBusWirer.js';
import { KanbanService } from '../services/KanbanService.js';
import { BoardBridge } from '../services/BoardBridge.js';
import { AgentStatusUpdater } from '../services/AgentStatusUpdater.js';
import { HumanInTheLoop } from '../services/HumanInTheLoop.js';
import { IdleController } from '../services/IdleController.js';
import { IdleWatchdog } from '../services/IdleWatchdog.js';
import { SubordinateLifecycle } from '../services/SubordinateLifecycle.js';
import { MasterLifecycle } from '../services/MasterLifecycle.js';
import { MasterAttention } from '../services/MasterAttention.js';
import { SandboxService } from '../services/SandboxService.js';
import { InboxQueue } from '../services/InboxQueue.js';
import { MasterInboxRouter } from '../services/MasterInboxRouter.js';
import { RuntimeReconciler } from '../services/RuntimeReconciler.js';
import { ServiceSupervisor } from '../services/service-supervisor/ServiceSupervisor.js';
import { CompanyScheduler } from '../services/scheduler/CompanyScheduler.js';
import { AppStudioScheduler } from '../services/scheduler/AppStudioScheduler.js';
import type { IKanbanNotifier } from '../services/ports.js';
import {
  constrainAutonomyForCapabilities,
  resolveCompanySessionCapabilities,
  resolveCompanyServiceWiringPlan,
} from '../services/session-capabilities.js';
import { CompanyDriveStore } from '../services/CompanyDriveStore.js';
import { CompanyEventBus } from '../services/CompanyEventBus.js';
import { createAutonomyProvider, type AutonomyProvider } from '../services/autonomy/autonomy-provider.js';
import type { CompanyOrchestratorPort as CompanyOrchestrator } from '../orchestrator-port.js';
import { CompanySessionFiles } from '../services/CompanySessionFiles.js';
import { consumeAutoContinueSignals } from './auto-continue-signals.js';

export interface WiredServices {
  ctx: SessionContext;
  publisher: MetaBusPublisher;
  wirer: MetaBusWirer;
  kanban: KanbanService | null;
  board: BoardBridge;
  status: AgentStatusUpdater;
  attention: MasterAttention;
  sandboxService: SandboxService;
  eventBus: CompanyEventBus;
  humanInLoop: HumanInTheLoop;
  idle: IdleController;
  watchdog: IdleWatchdog;
  subordinates: SubordinateLifecycle;
  master: MasterLifecycle;
  inbox: InboxQueue;
  masterInbox: MasterInboxRouter;
  reconciler: RuntimeReconciler;
  /**
   * B3 — per-session sandbox health watchdog. Constructed here (worker
   * only), STARTED by `MasterLifecycle.start/resumeExisting` after the
   * sandbox provision kicks off, stopped by `orchestrator.abortAll`
   * alongside the reconciler.
   */
  serviceSupervisor: ServiceSupervisor;
  scheduler: CompanyScheduler | null;
  appStudioScheduler: AppStudioScheduler | null;
  /**
   * C0/C2 — per-session autonomy config provider (cached read of
   * `config_json.autonomy`, invalidated on `session.config_updated`).
   * C2: consulted live by scheduler (tick), reconciler (orphan sweep),
   * HitL (plan auto-approve), spawn (global budget) and master
   * lifecycle (supervisor wiring).
   */
  autonomy: AutonomyProvider;
  driveStore: CompanyDriveStore;
  metaBus: CoderRunBus;
  parentSessionId: CompanySessionId | null;
}

/**
 * Build and back-wire every service the orchestrator composes. Returns the
 * full bag — the orchestrator constructor assigns from it.
 *
 * The order matters: Master is built first because HumanInTheLoop needs a
 * real ref to it; HitL is then back-wired into Master via a private setter.
 * Subordinate ↔ Idle no longer cross-cycle — both flow through `eventBus`.
 */
export function wireServices(args: {
  companySessionId: CompanySessionId | string;
  sessionStore: FsSessionStore;
  companyStore: CompanyStore;
  db: CodeIndexDB;
  orchestratorRef: CompanyOrchestrator;
}): WiredServices {
  const metaBus = createBus(new AbortController());
  const companySessionId = asCompanySessionId(String(args.companySessionId));
  const companyFiles = new CompanySessionFiles({
    companySessionId,
    sessionStore: args.sessionStore,
  });
  const sessionRow = companyFiles.getSession();
  const parentSessionId = sessionRow?.parent_session_id ?? null;
  const effectiveCompanyFiles =
    parentSessionId == null
      ? companyFiles
      : new CompanySessionFiles({
          companySessionId: parentSessionId,
          sessionStore: args.sessionStore,
        });
  const runtimeKind = sessionRow?.runtime_kind ?? 'company';
  const appStudioSessionId =
    runtimeKind === 'app_studio' ? companySessionId : null;
  const capabilities = resolveCompanySessionCapabilities(runtimeKind, appStudioSessionId);
  const servicePlan = resolveCompanyServiceWiringPlan(capabilities);

  // C0 — autonomy config provider. `applyConfigPatch` (this worker) publishes
  // `session.config_updated` on this same metaBus after persisting, so the
  // sink below keeps the cache coherent without timers.
  const persistedAutonomy = createAutonomyProvider({
    sessionSource: {
      getCompanySession: () => companyFiles.getSession(),
    },
    sessionId: companySessionId,
  });
  const autonomy: AutonomyProvider = capabilities.autonomyPolicy === 'controlled_app_work'
    ? {
        get: () => constrainAutonomyForCapabilities(capabilities, persistedAutonomy.get()),
        invalidate: () => persistedAutonomy.invalidate(),
      }
    : persistedAutonomy;
  addBusEventSink(metaBus, (ev) => {
    if (ev.event === 'session.config_updated') autonomy.invalidate();
  });

  const ctx = new SessionContext({
    companySessionId,
    companyFiles,
    effectiveCompanyFiles,
    companyStore: args.companyStore,
    db: args.db,
    metaBus,
    parentSessionId,
    runtimeKind,
    appStudioSessionId,
    capabilities,
  });

  const publisher = new MetaBusPublisher(metaBus);
  const wirer = new MetaBusWirer(publisher);
  const sandboxService = new SandboxService(ctx, publisher);
  // App Studio owns its work graph. Do not even construct the generic
  // Company Kanban service for App-backed sessions: completion, board and
  // reconciliation hooks receive a narrow no-op notifier instead, so an
  // overlooked generic callback cannot create/move Company cards.
  const kanban = servicePlan.initializeCompanyKanban
    ? new KanbanService(ctx, publisher)
    : null;
  const disabledKanbanNotifier: IKanbanNotifier = {
    findCardForAgent: () => null,
    addComment: () => undefined,
    moveCard: () => undefined,
    getCard: () => null,
  };
  const kanbanNotifier = kanban ?? disabledKanbanNotifier;
  const board = new BoardBridge(ctx, publisher, kanbanNotifier);
  const status = new AgentStatusUpdater(ctx, publisher);
  const attention = new MasterAttention();
  const driveStore = CompanyDriveStore.fromSessionContext(ctx, { publisher });
  const eventBus = new CompanyEventBus();

  // Master is built first because HitL needs a real ref to it.
  const master = new MasterLifecycle({
    ctx, board, status,
    humanInLoop: undefined as unknown as HumanInTheLoop,
    wirer, eventBus, attention,
    orchestratorRef: args.orchestratorRef,
    autonomy,
  });

  const humanInLoop = new HumanInTheLoop(publisher, board, status, master, attention, ctx, autonomy);
  // Back-fill HitL into Master via the typed private slot — visible and
  // breakable from a test fixture.
  (master as unknown as { deps: { humanInLoop: HumanInTheLoop } }).deps.humanInLoop = humanInLoop;

  const subordinates = new SubordinateLifecycle({
    ctx, board, status, kanban: kanbanNotifier, master, humanInLoop, wirer, eventBus,
    orchestratorRef: args.orchestratorRef, attention, autonomy,
  });

  const idle = new IdleController({
    ctx, bus: publisher, eventBus, subordinates,
    master: {
      get endedWithError() { return master.endedWithError; },
      get hasEnded() { return master.hasEnded; },
      get endedAt() { return master.endedAt; },
      get lastUserMessageAt() { return master.lastUserMessageAt; },
    },
    consumeMasterShouldContinue: () =>
      consumeAutoContinueSignals(
        { consume: () => humanInLoop.consumeMasterShouldContinue() },
        { consume: () => master.consumeShouldContinue() },
      ),
    onAutoContinue: () => {
      master.notify(
        '[SYSTEM] The human has responded. Continue orchestrating — call the appropriate tools to proceed with the next steps.',
      );
    },
  });

  // P15b — IdleWatchdog publishes `session_stalled` after N min of inactivity.
  // The publisher's activity listener ticks the watchdog so it doesn't need
  // to subscribe to each event type explicitly.
  const watchdog = new IdleWatchdog({
    ctx, bus: publisher,
    master: { get hasEnded() { return master.hasEnded; } },
    subordinates,
  });
  publisher.setActivityListener((event) => watchdog.recordActivity(event));
  watchdog.start();

  // Inbox: persistent message queue between subordinates. The lifecycle's
  // idle hook is wired here (late-bound) because the queue needs
  // `subordinates.reactivate` and the lifecycle was constructed before.
  const inbox = new InboxQueue({ ctx, subordinates, attention, publisher });
  subordinates.setOnSubordinateIdle((agentRunId, role) => {
    void inbox.drainOnIdle(agentRunId, role);
  });

  // Master inbox router — Phase A "living company". Built after master and
  // inbox so we can back-wire the router into the queue's master short-circuit.
  const masterInbox = new MasterInboxRouter({ ctx, master, publisher, eventBus });
  inbox.setMasterRouter(masterInbox);
  // Defer boot-time scan so listeners on `master.inbox_received` can subscribe
  // before the first emit.
  queueMicrotask(() => {
    try { masterInbox.reviveIfPending(); }
    catch (e) {
      console.warn(
        `[company s=${args.companySessionId}] master inbox revive on init failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  });

  // RuntimeReconciler — periodic DB↔runtime consistency sweep + master-inbox
  // heartbeat. Constructed AFTER masterInbox because it depends on it.
  const reconciler = new RuntimeReconciler({
    ctx, master, subordinates, masterInbox, publisher, humanInLoop, attention,
    kanban: kanban ?? undefined,
    autonomy,
  });
  reconciler.start();

  // ServiceSupervisor (B3) — sandbox health watchdog. Constructed after
  // inbox/kanban because the incident fan-out uses them. NOT started here:
  // MasterLifecycle start/resume calls `.start()` once the provision path
  // ran (back-wired below, same typed-private-slot pattern as humanInLoop).
  const serviceSupervisor = new ServiceSupervisor({
    sessionId: args.companySessionId,
    publisher,
    autonomy,
    incidents: {
      notifyMaster: (m) => master.notify(m),
      board,
      publisher,
      kanban: servicePlan.allowIncidentKanbanCards ? kanban ?? undefined : undefined,
      inbox,
      getSessionConfigJson: () =>
        ctx.effectiveCompanyFiles.getSession().config_json,
    },
  });
  (master as unknown as { deps: { serviceSupervisor?: ServiceSupervisor } }).deps.serviceSupervisor =
    serviceSupervisor;

  // CompanyScheduler — autonomous dispatch loop. C2 — ON by default: the
  // timer is always armed and each tick consults the autonomy provider, so
  // a session toggle (PATCH /config), `freeze`, or MCP_COMPANY_SCHEDULER='0'
  // kills it live without a worker restart.
  const scheduler = servicePlan.initializeCompanyScheduler && kanban
    ? new CompanyScheduler({
        ctx,
        kanban,
        master,
        subordinates,
        concurrencyLimit: subordinates.concurrencyPolicy.limit,
        // C1 — organism visibility: dispatch/skip/sweep events ride the session
        // metaBus so the dashboard's autonomy feed sees the scheduler act.
        bus: publisher,
        autonomy,
      })
    : null;
  scheduler?.start();
  const appStudioScheduler = capabilities.allowAppScheduler
    ? new AppStudioScheduler({
        ctx,
        host: args.orchestratorRef,
        master,
        bus: publisher,
        autonomy,
      })
    : null;
  appStudioScheduler?.start();

  return {
    ctx, publisher, wirer, kanban, board, status, attention,
    sandboxService, eventBus, humanInLoop, idle, watchdog,
    subordinates, master,
    inbox, masterInbox, reconciler, serviceSupervisor, scheduler,
    autonomy, driveStore, metaBus, parentSessionId, appStudioScheduler,
  };
}
