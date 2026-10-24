import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import type { NativeDuplexOptions, NativeHostDuplexProcess } from '@mcp/agent-runtime-host';
import { cleanProcessEnv, BoundedUtf8Capture } from '@mcp/code-agent/ports/shell-port.js';
import type { PreviewRunnerBridge, PreviewRunnerTask } from '@mcp/services/preview/contracts.js';
import { isDevServerCommand } from '@mcp/shared';
import { detectRunnersAsync } from '../../packages/api-handlers/src/runner/detect.js';

interface Server { task: PreviewRunnerTask; owner: NativeHostDuplexProcess; output: BoundedUtf8Capture; done: Promise<void> }

/** An attempt's auto-started preview servers are contained by native Jobs.
 * Closing waits for both pipe drains and physical descendant reap. */
export class NativePreviewServers {
  private readonly servers = new Map<string, Server>();
  private closed = false;
  private failure: unknown;
  private readonly cancel = () => { for (const server of this.servers.values()) server.owner.cancel(); };

  constructor(private readonly spawn: (options: NativeDuplexOptions) => NativeHostDuplexProcess,
    private readonly root: string, private readonly projectId: number | null,
    private readonly deadline: number, private readonly signal: AbortSignal,
    private readonly existing?: Pick<PreviewRunnerBridge, 'list' | 'readBuffer' | 'pinnedPort'> | null) {
    signal.addEventListener('abort', this.cancel, { once: true });
  }

  forInvocation(assertDispatch: () => void): PreviewRunnerBridge {
    const assertProject = (id: number) => { if (id !== this.projectId) throw new Error('Preview server project differs from its attempt'); };
    return {
      list: async () => [...this.servers.values()].map(server => ({ ...server.task }))
        .concat((await this.existing?.list() ?? []).filter(task => task.projectId === this.projectId)),
      pinnedPort: id => { assertProject(id); return this.existing?.pinnedPort(id) ?? null; },
      readBuffer: id => { const server = this.servers.get(id); return server ? [{ type: 'data', data: server.output.finishDetailed().content }] : this.existing?.readBuffer(id) ?? []; },
      detectDevCommand: async id => {
        assertProject(id); assertDispatch();
        const detected = await detectRunnersAsync(this.root, { shellFamily: 'cmd' });
        const runners = detected.groups.flatMap(group => group.runners);
        const runner = runners.find(item => /(^|[:\s])dev($|[:\s])/i.test(item.label))
          ?? runners.find(item => isDevServerCommand(item.command, item.label));
        return runner ? { command: runner.command, label: runner.label, manager: runner.manager } : null;
      },
      start: async input => {
        assertProject(input.projectId);
        if (this.closed || this.servers.size >= 4) throw new Error('Preview server scope is closed or full');
        this.signal.throwIfAborted();
        const remaining = this.deadline - Date.now();
        if (remaining <= 0) throw new Error('Preview server authority expired');
        const environment = Object.fromEntries(Object.entries(cleanProcessEnv()).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
        assertDispatch();
        let owner: NativeHostDuplexProcess;
        try {
          owner = this.spawn({ executable: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
            arguments: ['/d', '/s', '/c', input.command], cwd: this.root, environment,
            timeoutMs: Math.min(remaining, 86_400_000), streamStderr: true });
        } catch (cause) { this.failure = cause; throw cause; }
        const id = randomUUID();
        const server: Server = { owner, output: new BoundedUtf8Capture(128_000), done: Promise.resolve(),
          task: { taskId: id, terminalId: id, projectId: input.projectId, command: input.command, label: input.label, status: 'running' } };
        this.servers.set(id, server);
        server.done = this.observe(server);
        if (this.signal.aborted) owner.cancel();
        return { ...server.task };
      },
      stop: id => this.stop(id),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.signal.removeEventListener('abort', this.cancel);
    this.cancel();
    await Promise.all([...this.servers.values()].map(server => server.done));
    if (this.failure) throw new Error('Preview server cleanup is unconfirmed', { cause: this.failure });
    this.servers.clear();
  }

  private async stop(id: string): Promise<void> {
    const server = this.servers.get(id);
    if (!server) return;
    server.owner.cancel(); await server.done;
    if (this.failure) throw new Error('Preview server reap is unconfirmed', { cause: this.failure });
    this.servers.delete(id);
  }

  private async observe(server: Server): Promise<void> {
    const drain = async () => {
      if (!server.owner.readOutput) throw new Error('Native preview requires tagged output');
      const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
      let lastYield = performance.now();
      for (;;) {
        const chunk = await server.owner.readOutput();
        if (!chunk) break;
        server.output.append(decoders[chunk.stderr ? 1 : 0].write(Buffer.from(chunk.bytes)));
        if (performance.now() - lastYield >= 6) { await yieldEventLoop(); lastYield = performance.now(); }
      }
      for (const decoder of decoders) server.output.append(decoder.end());
    };
    const [read, exit] = await Promise.allSettled([
      drain().catch(cause => { server.owner.cancel(); throw cause; }), server.owner.wait(),
    ]);
    if (read.status === 'rejected' || exit.status === 'rejected' || !exit.value.reaped || exit.value.processId !== server.owner.processId) {
      this.failure ??= read.status === 'rejected' ? read.reason : exit.status === 'rejected' ? exit.reason : new Error('Missing preview server reap evidence');
    }
    server.task.status = exit.status === 'fulfilled' && exit.value.cancelled ? 'stopped' : 'exited';
  }
}
