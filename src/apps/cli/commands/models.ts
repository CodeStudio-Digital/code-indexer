import type { Command } from 'commander';
import { ModelDiscovery } from '../../../core/indexer/providers/model-discovery.js';
import { getDB } from '../helpers.js';
import type { ProviderName } from '../../../types.js';

export function register(program: Command): void {
  program.command('models').description('List available models')
    .option('-p, --provider <name>', 'Filter by provider')
    .option('--live', 'Force live discovery')
    .action(async (opts: { provider?: string; live?: boolean }) => {
      const db = getDB();
      const discovery = new ModelDiscovery(db);
      const models = await discovery.discoverModels(opts.provider as ProviderName | undefined, opts.live);
      for (const m of models) { console.log(`  [${m.provider}] ${m.id} — ${m.name}`); }
      db.close();
    });
}
