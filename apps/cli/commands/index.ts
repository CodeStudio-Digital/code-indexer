import type { Command } from 'commander';
import { register as projects } from './projects.js';
import { register as indexCmd } from './index-cmd.js';
import { register as search } from './search.js';
import { register as inspect } from './inspect.js';
import { register as snapshots } from './snapshots.js';
import { register as costs } from './costs.js';
import { register as exportCmd } from './export.js';
import { register as watch } from './watch.js';
import { register as webhooks } from './webhooks.js';
import { register as models } from './models.js';
import { register as deps } from './deps.js';
import { register as init } from './init.js';
import { register as serve } from './serve.js';
import { register as agent } from './agent.js';
import { register as hygiene } from './hygiene.js';
import { register as coderSnapshot } from './coder-snapshot.js';

const registrars: Array<(program: Command) => void> = [
  projects,
  indexCmd,
  search,
  inspect,
  snapshots,
  costs,
  exportCmd,
  watch,
  webhooks,
  models,
  deps,
  init,
  serve,
  agent,
  hygiene,
  coderSnapshot,
];

export function registerAll(program: Command): void {
  for (const r of registrars) r(program);
}
