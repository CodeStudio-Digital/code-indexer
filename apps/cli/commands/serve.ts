import type { Command } from 'commander';
import { loadConfig } from '@mcp/shared/utils/config.js';

export function register(program: Command): void {
  program.command('serve').description('Start REST API server')
    .option('--port <n>', 'Port number', parseInt)
    .action(async (opts: { port?: number }) => {
      const config = loadConfig();
      const port = opts.port ?? config.dashboard.port;
      // Load the HTTP entry point only for the serve command.
      const { startServer } = await import('../../http-api/server.js');
      await startServer(port, config.dashboard.host);
    });
}
