import type { ServerDeps } from './deps.js';
import type { McpExternalPool } from '../sse/McpExternalPool.js';
import {
  disposeCoderWorkerPool,
  setCoderWorkerDocDeps,
  setCoderWorkerMcpPool,
  setCoderWorkerControlPlaneStore,
} from '../sse/coderWorkerPoolSingleton.js';
import {
  disposeWorkerOrchestratorPool,
  setCompanyWorkerDocDeps,
} from '../sse/workerPoolSingleton.js';
import { disposePluginToolHost } from '../sse/PluginHostSingleton.js';
import { setBuilderCheckpointDeps } from '../sse/builder-checkpoint.js';
import { setWorkerLspDeps } from '../sse/worker-lsp-handlers.js';
import { setGlobalMcpExternalPool } from '../sse/McpExternalPool.js';
import { closeTerminalWebSocketProcesses } from './routes/terminal-ws.js';
import { runShutdownTasks } from './shutdown-tasks.js';
import { disposeIndexerProcessResources } from '@mcp/indexer/bootstrap/dispose.js';
import {
  disposeSharedSshResources,
  disposeProjectGitProcesses,
  disposeShellStreamProcesses,
  setLspExecutor,
  sharedPtyManager,
} from '@mcp/api-handlers';
import {
  setCompanySandboxServicesStore,
  setCompanySandboxStore,
  setCompanySessionEnvStore,
  setQaPreviewConfig,
  tryGetSandboxManager,
} from '@mcp/services/sandbox/index.js';
import {
  setCompanyLocalProjectStore,
  tryGetLocalProcessManager,
} from '@mcp/services/sandbox/local-process/LocalProcessManager.js';
import { type ChromeService, setChromeService } from '@mcp/services/chrome-service/chrome-service.js';
import { setGlobalRecentFilesTouchSink } from '@mcp/code-agent/tools/global-recent-files.js';
import { setGlobalFeedbackCollector } from '@mcp/services/shadow-traffic/index.js';
import { setEnvToolStore } from '@mcp/company/tools/env-tools.js';
import { setDbSecretDecryptor, setDbToolsStores } from '@mcp/code-agent/tools/db/index.js';
import { setQaEndpointEnvStore, setQaTestRunStore } from '@mcp/company/tools/qa/index.js';
import { setAppStudioDbClientStore, setAppStudioStore } from '@mcp/company/tools/app-studio/index.js';
import { setApiClientStore } from '@mcp/code-agent/tools/api-client/index.js';
import { setSandboxServiceEnvStore } from '@mcp/company/services/SandboxService.js';
import { setChromeServiceForDocs } from './deps.js';
import { setGlobalDocSearch } from '@mcp/code-agent/tools/rag-search-docs.js';
import { setGlobalDocsHintProvider } from '@mcp/code-agent/core/docs-hint.js';
import { setGlobalVisionDescriber } from '@mcp/code-agent/core/vision-describer.js';
import { setGlobalDocsResearcher } from '@mcp/docs-agent/bridges/docs-bridge.js';
import { setGlobalAgentLspBackend } from '@mcp/code-agent/lsp/agent-lsp-backend.js';
import {
  disposeTrackedProcessTrees,
  disposeTrackedProcessTreesSync,
} from '@mcp/shared/utils/process-tree.js';
import { disposeGoogleOAuthResources } from '@mcp/services/services/oauth/google.js';
import { disposeOpenAiOAuthResources } from '@mcp/services/services/oauth/openai.js';
import { disposeClaudeCodeOAuthResources } from '@mcp/services/services/oauth/claude-code.js';
import { getMemoryLedger } from './perf/memory-ledger.js';
import { stopPersistentPerfDiagnostics } from './perf/persistent-diagnostics.js';

interface RuntimeShutdownResources {
  deps: ServerDeps;
  mcpPool: McpExternalPool;
  chromeService: ChromeService;
  reason?: string;
}

const shutdownByDeps = new WeakMap<object, Promise<void>>();

function disposeAppProcessHandles(): void {
  const disposers: Array<() => unknown> = [
    closeTerminalWebSocketProcesses,
    () => sharedPtyManager.killAll(),
    disposeProjectGitProcesses,
    disposeShellStreamProcesses,
    disposeSharedSshResources,
    disposeGoogleOAuthResources,
    disposeOpenAiOAuthResources,
    disposeClaudeCodeOAuthResources,
  ];
  for (const dispose of disposers) {
    try { dispose(); } catch { /* continue the emergency sweep */ }
  }
}

/** Non-blocking process cleanup for the normal graceful-shutdown path. */
async function disposeAppProcessResources(): Promise<void> {
  disposeAppProcessHandles();
  await disposeTrackedProcessTrees();
}

/** Synchronous last resort for process `exit` and repeated termination signals. */
export function forceDisposeAppProcessResources(): void {
  disposeAppProcessHandles();
  disposeTrackedProcessTreesSync();
}

async function settleNamed(entries: Array<[string, Promise<unknown> | unknown]>): Promise<void> {
  const results = await Promise.allSettled(entries.map(([, work]) => Promise.resolve(work)));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.warn(
        `[shutdown] ${entries[index][0]} failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
    }
  });
}

/**
 * Drain every process-wide runtime owned by createApp(). Ordering matters:
 * host process trees close without blocking the main event loop; workers and
 * external services then drain while SQLite is alive; the central DB handle
 * closes last. The WeakMap makes concurrent Electron, signal, and restart
 * requests share one shutdown.
 */
export function shutdownAppRuntime(resources: RuntimeShutdownResources): Promise<void> {
  const existing = shutdownByDeps.get(resources.deps);
  if (existing) return existing;

  const shutdown = (async () => {
    // Reap host-side process trees before draining workers. On Windows this
    // uses the bounded asynchronous taskkill queue, so a suspended helper can
    // no longer freeze Electron's main event loop.
    await disposeAppProcessResources();

    // Trigger worker parking and external-service teardown together. We still
    // await workers first before closing stores/DB, but containers and host
    // dev servers start stopping immediately so a stuck worker cannot orphan
    // them. Worker stop handlers sweep process trees in their own realm.
    const workerShutdowns: Array<[string, Promise<unknown> | unknown]> = [
      ['coder worker pool', disposeCoderWorkerPool()],
      ['company worker pool', disposeWorkerOrchestratorPool()],
    ];
    const localProcesses = tryGetLocalProcessManager();
    const sandboxes = tryGetSandboxManager();
    const externalResourcesShutdown = settleNamed([
      ['indexer process resources', disposeIndexerProcessResources()],
      ['external MCP pool', resources.mcpPool.shutdown()],
      ['plugin tool worker', disposePluginToolHost()],
      ['local project processes', localProcesses?.killAll(resources.reason ?? 'app-quit')],
      ['sandbox containers', sandboxes?.destroyAll(resources.reason ?? 'app-quit')],
      ['Chrome Service', resources.chromeService.shutdown()],
    ]);
    await settleNamed(workerShutdowns);

    await settleNamed([
      ['registered shutdown tasks', runShutdownTasks()],
      ['external runtime resources', externalResourcesShutdown],
    ]);

    // The sampler, watchdog and IPC producers above have stopped. Seal the
    // journal only now so a clean marker can never race with a final event.
    await stopPersistentPerfDiagnostics(resources.reason ?? 'runtime-shutdown');

    setCoderWorkerMcpPool(null);
    setCoderWorkerDocDeps(null);
    setCoderWorkerControlPlaneStore(null);
    setCompanyWorkerDocDeps(null);
    setGlobalMcpExternalPool(null);
    setChromeService(null);
    setCompanyLocalProjectStore(null);
    setCompanySandboxStore(null);
    setCompanySandboxServicesStore(null);
    setCompanySessionEnvStore(null);
    setQaPreviewConfig(null);
    setBuilderCheckpointDeps(null);
    setWorkerLspDeps(null);
    setGlobalRecentFilesTouchSink(null);
    setLspExecutor(null);
    setGlobalAgentLspBackend(null);
    setGlobalFeedbackCollector(undefined);
    setEnvToolStore(null);
    setDbToolsStores(null, null);
    setDbSecretDecryptor(null);
    setQaTestRunStore(null);
    setQaEndpointEnvStore(null);
    setAppStudioDbClientStore(null);
    setAppStudioStore(null);
    setApiClientStore(null);
    setSandboxServiceEnvStore(null);
    setChromeServiceForDocs(null);
    setGlobalDocSearch(null);
    setGlobalDocsHintProvider(null);
    setGlobalDocsResearcher(null);
    setGlobalVisionDescriber(null);
    getMemoryLedger().unregister('lsp.servers');

    // Must be last: most disposers persist final state or read configuration.
    try {
      resources.deps.db.close();
    } catch (error) {
      console.warn(`[shutdown] main database close failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
  shutdownByDeps.set(resources.deps, shutdown);
  return shutdown;
}
