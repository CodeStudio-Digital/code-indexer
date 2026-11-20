import { nodeApiFiles } from '../../host-scaffold/templates/node-api.js';
import { relaunchDevServer } from '../manager/dev-server-runtime.js';
import type { IScaffolder, ScaffoldContext } from './scaffolder-port.js';
import type { SandboxStack } from '../types.js';

export class ViteApiScaffolder implements IScaffolder {
  readonly stack: SandboxStack = 'vite-api';

  async scaffold(ctx: ScaffoldContext): Promise<void> {
    const { driver, containerId, workdir, emit, sandboxId, signal } = ctx;
    emit({ kind: 'step', sandboxId, step: 'scaffolding', message: 'Scaffolding Node.js API…' });
    for (const [file, contents] of Object.entries(nodeApiFiles('sandbox-vite-api', ctx.previewPathPrefix))) {
      signal?.throwIfAborted();
      await driver.writeFile(containerId, workdir + '/' + file, contents, { recursive: true });
    }

    emit({
      kind: 'step',
      sandboxId,
      step: 'starting-dev-server',
      message: 'Starting Node.js API on port ' + ctx.devServerPort + '…',
    });
    await relaunchDevServer(driver, containerId, workdir, this.stack, ctx.devServerPort, signal);
  }
}
