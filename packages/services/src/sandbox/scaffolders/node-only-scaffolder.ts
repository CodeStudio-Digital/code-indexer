/**
 * Node-only scaffolder.
 *
 * No-op scaffold. The container is already provisioned by the manager
 * with the bind-mounted virtual project root, Node + npm pre-installed
 * (via the standard `mcp-sandbox-node:20` image), and `tail -f /dev/null`
 * keeping it alive (CliOciDriver default).
 *
 * Used by Design System Creator sessions, which do NOT want the Vite
 * scaffold polluting `/app` (the virtual project root holds the
 * uploaded theme at `/app/design_system/` plus the agent's emitted
 * package at `/app/pkg/` — running `npm create vite` here would
 * sprinkle a competing React app at the root).
 *
 * Just emits a single progress event and resolves so the manager can
 * flip the sandbox status to `ready`.
 */
import type { IScaffolder, ScaffoldContext } from './scaffolder-port.js';
import type { SandboxStack } from '../types.js';

export class NodeOnlyScaffolder implements IScaffolder {
  readonly stack: SandboxStack = 'node-only';

  async scaffold(ctx: ScaffoldContext): Promise<void> {
    ctx.emit({
      kind: 'step',
      sandboxId: ctx.sandboxId,
      step: 'ready',
      message:
        'Node-only sandbox: no scaffolding performed. Container has node + npm + git; ' +
        'virtual project root is bind-mounted at workdir.',
    });
  }
}
