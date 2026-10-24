/** In-process host API for CLI composition; the application owns its resources. */
export async function createAgentCliRuntime() {
  const [{ createApp }, { shutdownAppRuntime }] = await Promise.all([
    import('./server.js'), import('./server/runtime-shutdown.js'),
  ]);
  const runtime = createApp();
  return {
    listProjects: () => runtime.db.listProjects(),
    request: async (path: string, init?: RequestInit): Promise<Response> => runtime.app.request(path, init),
    close: () => shutdownAppRuntime({ ...runtime, reason: 'cli-agent-finished' }),
  };
}
