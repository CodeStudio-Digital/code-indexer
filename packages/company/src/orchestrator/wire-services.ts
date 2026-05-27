import type { CompanyStore } from '@mcp/store/company-store.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { createBus, type CoderRunBus } from '@apps/http-api/coder-bus.js';

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
import { PipelineService } from '../services/PipelineService.js';
import { PipelineExecutor } from '../services/PipelineExecutor.js';
import { InboxQueue } from '../services/InboxQueue.js';
import { MasterInboxRouter } from '../services/MasterInboxRouter.js';
import { RuntimeReconciler } from '../services/RuntimeReconciler.js';
import { CompanyDriveStore } from '../services/CompanyDriveStore.js';
import { CompanyEventBus } from '../services/CompanyEventBus.js';
import type { CompanyOrchestrator } from '../orchestrator.js';

export interface WiredServices {
  ctx: SessionContext;
  publisher: MetaBusPublisher;
  wirer: MetaBusWirer;
  kanban: KanbanService;
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
  pipelines: PipelineService;
  pipelineExecutor: PipelineExecutor;
  inbox: InboxQueue;
  masterInbox: MasterInboxRouter;
  reconciler: RuntimeReconciler;
  driveStore: CompanyDriveStore;
  metaBus: CoderRunBus;
  parentSessionId: number | null;
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
  companySessionId: number;
  companyStore: CompanyStore;
  db: CodeIndexDB;
  orchestratorRef: CompanyOrchestrator;
}): WiredServices {
  const metaBus = createBus(new AbortController());
  // Resolve parent linkage (migration 067).
  const sessionRow = args.companyStore.getCompanySession(args.companySessionId);
  const parentSessionId = sessionRow?.parent_session_id ?? null;

  const ctx = new SessionContext({
    companySessionId: args.companySessionId,
    companyStore: args.companyStore,
    db: args.db,
    metaBus,
    parentSessionId,
  });

  const publisher = new MetaBusPublisher(metaBus);
  const wirer = new MetaBusWirer(publisher);
  const sandboxService = new SandboxService(ctx, publisher);
  const kanban = new KanbanService(ctx, publisher);
  const board = new BoardBridge(ctx, publisher, kanban);
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
  });

  const humanInLoop = new HumanInTheLoop(publisher, board, status, master, attention, ctx);
  // Back-fill HitL into Master via the typed private slot — visible and
  // breakable from a test fixture.
  (master as unknown as { deps: { humanInLoop: HumanInTheLoop } }).deps.humanInLoop = humanInLoop;

  const subordinates = new SubordinateLifecycle({
    ctx, board, status, kanban, master, humanInLoop, wirer, eventBus,
    orchestratorRef: args.orchestratorRef, attention,
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
      humanInLoop.consumeMasterShouldContinue() || master.consumeShouldContinue(),
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
  publisher.setActivityListener(() => watchdog.recordActivity());
  watchdog.start();

  // Pipelines: thin CRUD + executor that drives subordinates through a stored
  // graph. Constructed last because the executor needs already-wired services.
  const pipelines = new PipelineService(ctx);
  const pipelineExecutor = new PipelineExecutor({
    ctx, pipelines, kanban, subordinates, attention, publisher,
  });

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
  const reconciler = new RuntimeReconciler({ ctx, master, subordinates, masterInbox, publisher });
  reconciler.start();

  return {
    ctx, publisher, wirer, kanban, board, status, attention,
    sandboxService, eventBus, humanInLoop, idle, watchdog,
    subordinates, master, pipelines, pipelineExecutor,
    inbox, masterInbox, reconciler, driveStore, metaBus, parentSessionId,
  };
}
