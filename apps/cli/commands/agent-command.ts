import { resolve } from 'node:path';
import { once } from 'node:events';
import { promptStdin } from '../helpers.js';
import { runAgentSession, type AgentCliOptions } from './agent-session-client.js';

/** Standalone CLI composition. It owns an in-process API gateway and its worker
 * tree, opens no listening port, and drains that tree before returning. */
export async function runAgentCommand(task: string, options: AgentCliOptions): Promise<number> {
  if (options.profile && !['bootstrap', 'navigate', 'full', 'auto'].includes(options.profile)) {
    throw new Error(`Unknown profile '${options.profile}'. Valid: bootstrap, navigate, full, auto.`);
  }
  const controller = new AbortController();
  // Background services deliberately unref their timers. Unlike Electron the
  // CLI has no window keeping Node alive while their final durable drain runs.
  const keepAlive = setInterval(() => {}, 1_000);
  const interrupted = () => controller.abort(new Error('CLI interrupted'));
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  let runtime: ReturnType<typeof import('../../http-api/server.js').createApp> | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  try {
    const { createApp } = await import('../../http-api/server.js');
    const { shutdownAppRuntime } = await import('../../http-api/server/runtime-shutdown.js');
    controller.signal.throwIfAborted();
    runtime = createApp();
    shutdown = () => shutdownAppRuntime({ ...runtime!, reason: 'cli-agent-finished' });
    const projects = runtime.db.listProjects();
    const project = options.project ? projects.find(row => row.name === options.project)
      : projects.find(row => resolve(row.root_path) === resolve(process.cwd()));
    if (!options.session && !project) throw new Error(options.project ? `Project '${options.project}' not found`
      : `No indexed project at ${process.cwd()}. Pass --project <name> or run 'mcp-code-indexer index .' first.`);
    const result = await runAgentSession({ task, options, projectId: project?.id, projectName: options.session ? undefined : project?.name,
      request: async (path, init) => runtime!.app.request(path, init), signal: controller.signal,
      io: { write: text => { process.stdout.write(text); }, prompt: promptStdin,
        flush: async () => { if (process.stdout.writableNeedDrain) await once(process.stdout, 'drain', { signal: controller.signal }); } } });
    return result.classification === 'completed' ? 0 : result.classification === 'cancelled' ? 130 : 1;
  } finally {
    try { await shutdown?.(); }
    finally { clearInterval(keepAlive); process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted); }
  }
}
