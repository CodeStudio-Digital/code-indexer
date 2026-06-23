/**
 * Plugin worker entrypoint. Loads installed plugins' built bundles and runs
 * their tool handlers in this isolated worker_thread, off the main loop.
 *
 * IMPORTANT: workers import via RELATIVE paths only — alias imports (e.g.
 * `@mcp/plugin-host`) throw "Cannot find package" inside a worker_thread
 * because Node's loader resolves them before tsx/tsconfig `paths` register.
 * Mirrors coder-worker.ts.
 *
 * Protocol (over parentPort):
 *   main → worker : { kind:'invoke', id, namespace, name, args }
 *                   { kind:'hostResult', id, ok, value?, error? }
 *   worker → main : { kind:'ready' } | { kind:'error', message }
 *                   { kind:'result', id, content, isError }
 *                   { kind:'host', id, method, payload }   (reverse host.invoke)
 *                   { kind:'log', namespace, message }
 */
import { parentPort, workerData } from 'node:worker_threads';
import {
  loadPluginTools,
  invokePluginTool,
  type PluginToolMap,
} from '../../../packages/plugin-host/src/worker/runtime.js';
import { buildSandboxContext } from '../../../packages/plugin-host/src/worker/sandbox-ctx.js';

interface PluginWorkerData {
  bundles: { namespace: string; file: string }[];
}

const port = parentPort;
if (!port) throw new Error('plugin-worker.ts: not running inside a worker_thread');

const { bundles } = workerData as PluginWorkerData;

// Reverse host.invoke correlation (worker → main → worker).
let hostSeq = 0;
const pendingHost = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function hostInvoke(
  method: string,
  payload: unknown,
  namespace: string,
  cwd: string,
): Promise<unknown> {
  const id = ++hostSeq;
  return new Promise((resolve, reject) => {
    pendingHost.set(id, { resolve, reject });
    // namespace + cwd ride along so the host can scope + permission-check.
    port!.postMessage({ kind: 'host', id, method, payload, namespace, cwd });
  });
}

let toolsPromise: Promise<PluginToolMap> | null = null;
const tools = (): Promise<PluginToolMap> => (toolsPromise ??= loadPluginTools(bundles));

async function onInvoke(msg: {
  id: number;
  namespace: string;
  name: string;
  args?: Record<string, unknown>;
  projectName: string | null;
  cwd: string;
}): Promise<void> {
  const ctx = buildSandboxContext({
    projectName: msg.projectName,
    cwd: msg.cwd,
    log: (message) => port!.postMessage({ kind: 'log', namespace: msg.namespace, message }),
    hostInvoke: (method, payload) => hostInvoke(method, payload, msg.namespace, msg.cwd),
  });
  const result = await invokePluginTool(await tools(), msg.namespace, msg.name, msg.args ?? {}, ctx);
  port!.postMessage({
    kind: 'result',
    id: msg.id,
    content: result.content,
    isError: result.isError,
    data: result.data,
  });
}

function onHostResult(msg: { id: number; ok: boolean; value?: unknown; error?: string }): void {
  const p = pendingHost.get(msg.id);
  if (!p) return;
  pendingHost.delete(msg.id);
  if (msg.ok) p.resolve(msg.value);
  else p.reject(new Error(msg.error ?? 'host.invoke failed'));
}

port.on('message', (msg: Record<string, unknown>) => {
  if (msg.kind === 'invoke') {
    void onInvoke(msg as Parameters<typeof onInvoke>[0]).catch((e) =>
      port!.postMessage({
        kind: 'result',
        id: (msg as { id: number }).id,
        content: e instanceof Error ? e.message : String(e),
        isError: true,
      }),
    );
  } else if (msg.kind === 'hostResult') {
    onHostResult(msg as Parameters<typeof onHostResult>[0]);
  }
});

// Preload bundles, then signal readiness.
void tools().then(
  () => port!.postMessage({ kind: 'ready' }),
  (e) => port!.postMessage({ kind: 'error', message: e instanceof Error ? e.message : String(e) }),
);
