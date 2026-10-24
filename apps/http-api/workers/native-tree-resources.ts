import type { NativeHostBridgeBinding, NativeHostResourceBounds } from '../../../packages/agent-runtime-host/src/native/NativeHostBridgeBinding.js';

export interface NativeTreeResourceLimits {
  readonly memoryBytes: number;
  readonly processes: number;
}
type Kind = 'supervisor' | 'command' | 'duplex';

/** Reserve the sum of the OS-enforced per-Job maxima before launching anything.
 * Includes each supervisor and its nested runner, and every worker-owned Host
 * command/LSP/SQLite Job. Shared main-process services have their own owners.
 * These are committed-memory bounds, not measurements of RSS or CPU usage. */
export class NativeTreeResources {
  private bytes = 0;
  private processes = 0;
  private groups = 0;
  readonly limits: NativeTreeResourceLimits;

  constructor(private readonly signal: AbortSignal,
    limits: NativeTreeResourceLimits = { memoryBytes: 8 * 1024 ** 3, processes: 256 }) {
    if (![limits.memoryBytes, limits.processes].every(n => Number.isSafeInteger(n) && n > 0)
      || limits.memoryBytes > 32 * 1024 ** 3 || limits.processes > 4096) throw new Error('Invalid native tree resource limits');
    this.limits = Object.freeze({ ...limits });
  }

  snapshot() { return { memoryBytes: this.bytes, processes: this.processes, groups: this.groups }; }

  bind(binding: NativeHostBridgeBinding) {
    const bounds = binding.nativeHostBridgeAbi().resourceBounds;
    if (!bounds || bounds.version !== 1 || ![
      bounds.supervisorMemoryBytes, bounds.supervisorProcesses, bounds.commandMemoryBytes,
      bounds.commandProcesses, bounds.duplexMemoryBytes, bounds.duplexProcesses,
    ].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Native package lacks verified process resource bounds');
    const maxima = Object.freeze({ ...bounds });
    const startCommand = binding.startNativeHostCommand;
    const startDuplex = binding.startNativeHostDuplexProcess;
    return {
      reserveRuntime: () => this.reserve('supervisor', maxima),
      startCommand: startCommand && ((options: Parameters<typeof startCommand>[0]) => {
        const release = this.reserve('command', maxima);
        // A throwing launch may already own an unreaped process. Keep its
        // reservation until this tree ends; never create capacity from doubt.
        const owner = startCommand(options);
        const done = owner.wait().then(result => { if (result.reaped) release(); return result; });
        void done.catch(() => undefined);
        return { processId: owner.processId, cancel: () => owner.cancel(), wait: () => done };
      }),
      startDuplex: startDuplex && ((options: Parameters<typeof startDuplex>[0]) => {
        const release = this.reserve('duplex', maxima);
        const owner = startDuplex(options);
        const done = owner.wait().then(result => { if (result.reaped) release(); return result; });
        void done.catch(() => undefined);
        return { processId: owner.processId, write: owner.write.bind(owner), read: owner.read.bind(owner),
          ...(owner.readOutput ? { readOutput: owner.readOutput.bind(owner) } : {}),
          cancel: () => owner.cancel(), wait: () => done };
      }),
    };
  }

  private reserve(kind: Kind, bounds: NativeHostResourceBounds): () => void {
    this.signal.throwIfAborted();
    const bytes = bounds[`${kind}MemoryBytes`], processes = bounds[`${kind}Processes`];
    if (bytes > this.limits.memoryBytes - this.bytes || processes > this.limits.processes - this.processes) {
      throw new Error(`Native tree resource budget exhausted before ${kind} launch (${this.bytes}/${this.limits.memoryBytes} bytes; ${this.processes}/${this.limits.processes} processes reserved)`);
    }
    this.bytes += bytes; this.processes += processes; this.groups++;
    let released = false;
    return () => { if (!released) { released = true; this.bytes -= bytes; this.processes -= processes; this.groups--; } };
  }
}
