import type { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { CodeIndexDB } from '@mcp/store/db.js';
import { requestLocalServer } from '../semantic-control.js';

export function register(program: Command): void {
  program.command('watch [project]').description('Watch for file changes')
    .option('--all', 'Watch all projects')
    .option('--daemon', 'Run as daemon')
    .action(async (projectName: string | undefined, opts: { all?: boolean; daemon?: boolean }) => {
      const config = loadConfig();
      const db = new CodeIndexDB(config.dbPath);

      const projectsToWatch = opts.all ? db.listProjects() : (() => {
        if (!projectName) { console.error('Specify project or --all'); process.exit(1); }
        const p = db.getProjectByName(projectName);
        if (!p) { console.error('Project not found'); process.exit(1); }
        return [p];
      })();
      if (projectsToWatch.length === 0) {
        console.log('No projects registered.');
        db.close();
        return;
      }

      const clientId = `cli-watch:${process.pid}:${randomUUID()}`;
      const activations: Array<{ projectId: number; activationId: string }> = [];
      for (const project of projectsToWatch) {
        const activationId = randomUUID();
        const response = await requestLocalServer(`/api/projects/${project.id}/activation`, {
          method: 'POST',
          body: JSON.stringify({ activationId, clientId }),
        });
        if (!response.ok) {
          await Promise.allSettled(activations.map(({ projectId, activationId: activeId }) =>
            requestLocalServer(`/api/projects/${projectId}/activation`, {
              method: 'DELETE',
              body: JSON.stringify({ activationId: activeId, clientId }),
            })));
          db.close();
          throw new Error(
            `The local server must own project watchers: ${response.error ?? 'server unavailable'}`,
          );
        }
        activations.push({ projectId: project.id, activationId });
        console.log(`Watching ${project.name} (${project.root_path})`);
      }

      const shutdown = async () => {
        console.log('\nStopping watchers...');
        await Promise.allSettled(activations.map(({ projectId, activationId }) =>
          requestLocalServer(`/api/projects/${projectId}/activation`, {
            method: 'DELETE',
            body: JSON.stringify({ activationId, clientId }),
          })));
        db.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      await new Promise(() => {});
    });
}
