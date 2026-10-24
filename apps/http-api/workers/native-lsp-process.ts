import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { NativeDuplexOptions, NativeHostDuplexProcess } from '@mcp/agent-runtime-host';
import { cleanProcessEnv } from '@mcp/code-agent/ports/shell-port.js';

export interface NativeLspProcessOptions {
  spawn(options: NativeDuplexOptions): NativeHostDuplexProcess;
  deadline: number;
  executable?: string;
  workerPath?: string;
}

/** TypeScript runs in a native Job-owned process. V8 fatal errors and bootstrap
 * cancellation cannot crash the Electron process which owns the attempt. */
export class NativeLspProcess extends EventEmitter {
  readonly processId: number;
  reaped = false;
  private readonly child: NativeHostDuplexProcess;
  private readonly done: Promise<void>;
  private failure?: Error;
  constructor(root: string, options: NativeLspProcessOptions) {
    super();
    const worker = options.workerPath ?? fileURLToPath(new URL('./agent-lsp-worker.js', import.meta.url));
    if (!existsSync(worker)) throw new Error('Agent LSP process is unavailable; rebuild the application');
    const remaining = options.deadline - Date.now();
    if (remaining <= 0) throw new Error('Agent LSP process authority expired');
    const environment = Object.fromEntries(Object.entries(cleanProcessEnv()).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    environment.ELECTRON_RUN_AS_NODE = '1';
    this.child = options.spawn({ executable: options.executable ?? process.execPath,
      arguments: ['--max-old-space-size=768', '--max-semi-space-size=32', worker],
      cwd: root, environment, timeoutMs: Math.min(remaining, 86_400_000), streamStderr: true });
    this.processId = this.child.processId;
    // Observe an idle failure even when no query currently listens.
    this.on('error', () => {});
    this.done = this.observe();
  }
  postMessage(value: unknown): void {
    if (this.reaped) throw new Error('Agent LSP process has ended');
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    if (bytes.byteLength > 256 * 1024) throw new Error('Agent LSP request exceeds 256 KiB');
    void this.child.write(bytes).wait().catch(error => { this.child.cancel(); this.emit('error', error); });
  }
  async terminate(): Promise<void> {
    this.child.cancel(); await this.done;
    if (!this.reaped || this.failure) throw this.failure ?? new Error('Missing LSP process reap confirmation');
  }
  private async observe(): Promise<void> {
    const drain = async () => {
      if (!this.child.readOutput) throw new Error('Agent LSP requires tagged process output');
      const decoder = new StringDecoder('utf8'); let fragments: string[] = [], size = 0;
      for (;;) {
        const part = await this.child.readOutput(); if (!part) break;
        if (part.stderr) continue;
        const segments = decoder.write(Buffer.from(part.bytes)).split('\n');
        for (let index = 0; index < segments.length; index++) {
          const segment = segments[index]; size += Buffer.byteLength(segment);
          if (size > 16 * 1024 * 1024) throw new Error('Agent LSP response exceeds 16 MiB');
          if (segment) fragments.push(segment);
          if (index === segments.length - 1) break;
          const frame = JSON.parse(fragments.join('')); fragments = []; size = 0;
          if (!Number.isSafeInteger(frame.id) || (typeof frame.encoded !== 'string' && typeof frame.error !== 'string')) throw new Error('Invalid Agent LSP response');
          this.emit('message', frame);
        }
      }
      if (size || decoder.end()) throw new Error('Agent LSP exited with an incomplete response');
    };
    const [output, exit] = await Promise.allSettled([
      drain().catch(error => { this.child.cancel(); throw error; }), this.child.wait(),
    ]);
    this.reaped = exit.status === 'fulfilled' && exit.value.reaped && exit.value.processId === this.processId;
    if (!this.reaped) this.failure = new Error('Missing LSP process reap confirmation');
    if (output.status === 'rejected') this.emit('error', output.reason);
    if (this.failure) this.emit('error', this.failure);
    this.emit('exit', exit.status === 'fulfilled' ? exit.value.exitCode : -1);
  }
}
