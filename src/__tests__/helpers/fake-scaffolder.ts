/**
 * Minimal in-memory scaffolder for tests that exercise `provision()`
 * without spinning up a real `npm create vite` or any scaffolder I/O.
 *
 * Records every `scaffold` call into `this.calls` so assertions can
 * verify the manager passed the expected `sandboxId`/`previewUrl`/etc.
 * Resolves immediately — production scaffolders wait for the dev
 * server to bind, but the test path stubs that via the fake driver's
 * `isPortListening`.
 */
import type { SandboxStack } from '@mcp/services/sandbox/types.js';
import type {
  IScaffolder,
  ScaffoldContext,
} from '@mcp/services/sandbox/scaffolders/scaffolder-port.js';

export interface FakeScaffolderCall {
  sandboxId: string;
  containerId: string;
  workdir: string;
  devServerPort: number;
  previewUrl: string;
  previewPathPrefix: string;
  includeE2e: boolean | undefined;
}

export class FakeScaffolder implements IScaffolder {
  readonly stack: SandboxStack;
  readonly calls: FakeScaffolderCall[] = [];

  constructor(stack: SandboxStack) {
    this.stack = stack;
  }

  async scaffold(ctx: ScaffoldContext): Promise<void> {
    this.calls.push({
      sandboxId: ctx.sandboxId,
      containerId: ctx.containerId,
      workdir: ctx.workdir,
      devServerPort: ctx.devServerPort,
      previewUrl: ctx.previewUrl,
      previewPathPrefix: ctx.previewPathPrefix,
      includeE2e: ctx.includeE2e,
    });
    // Emit a synthetic ready step so observers see the same shape as
    // production. Manager downgrades unknown event kinds to no-op.
    ctx.emit({
      kind: 'step',
      sandboxId: ctx.sandboxId,
      step: 'starting-dev-server',
      message: 'Fake scaffolder: dev server "starting"…',
    });
  }
}
