import { describe, expect, it, vi } from 'vitest';
import { NativeTreeResources } from '../workers/native-tree-resources.js';
import type { NativeHostBridgeBinding } from '../../../packages/agent-runtime-host/src/native/NativeHostBridgeBinding.js';
import type { NativeHostCommand, NativeHostCommandResult } from '../../../packages/agent-runtime-host/src/native/NativeHostCommand.js';

const bounds = { version: 1, supervisorMemoryBytes: 512, supervisorProcesses: 17,
  commandMemoryBytes: 2048, commandProcesses: 128, duplexMemoryBytes: 2048, duplexProcesses: 32 };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  const completion = deferred<NativeHostCommandResult>();
  const owner: NativeHostCommand = { processId: 123, cancel: vi.fn(), wait: vi.fn(() => completion.promise) };
  const binding = { nativeHostBridgeAbi: () => ({ resourceBounds: bounds }), startNativeHostCommand: vi.fn(() => owner),
    startNativeHostDuplexProcess: vi.fn(() => ({ ...owner, write: vi.fn(), read: vi.fn(), readOutput: vi.fn() })) } as unknown as NativeHostBridgeBinding;
  const ctrl = new AbortController(); const resources = new NativeTreeResources(ctrl.signal, { memoryBytes: 8192, processes: 256 });
  return { completion, owner, binding, ctrl, resources, process: resources.bind(binding) };
}
const command = { executable: 'fixture', arguments: [], cwd: '.', environment: {}, stdin: new Uint8Array(), timeoutMs: 1000, maximumOutputBytes: 10 };
const result = (reaped = true) => ({ processId: 123, reaped }) as NativeHostCommandResult;

describe('tree process resource admission', () => {
  it('accounts parent, children and mixed Host Jobs together and refuses before launch', async () => {
    const f = fixture(); const parent = f.process.reserveRuntime(), child = f.resources.bind(f.binding).reserveRuntime();
    const commandOwner = f.process.startCommand!(command);
    f.process.startDuplex!(command);
    expect(f.resources.snapshot()).toEqual({ groups: 4, memoryBytes: 5120, processes: 194 });
    expect(() => f.resources.bind(f.binding).startCommand!(command)).toThrow('budget exhausted before command');
    expect(f.binding.startNativeHostCommand).toHaveBeenCalledTimes(1);
    child(); child(); expect(f.resources.snapshot().groups).toBe(3);
    commandOwner.cancel(); expect(f.resources.snapshot().groups).toBe(3);
    f.completion.resolve(result()); await commandOwner.wait(); await Promise.resolve();
    parent(); expect(f.resources.snapshot()).toEqual({ groups: 0, memoryBytes: 0, processes: 0 });
  });

  it('enforces the memory sum even with process capacity remaining', () => {
    const f = fixture(); const limited = new NativeTreeResources(f.ctrl.signal, { memoryBytes: 2500, processes: 512 }).bind(f.binding);
    limited.reserveRuntime(); expect(() => limited.startDuplex!(command)).toThrow('budget exhausted');
    expect(f.binding.startNativeHostDuplexProcess).not.toHaveBeenCalled();
  });

  it.each(['not_reaped', 'wait_failure', 'launch_failure'] as const)('keeps uncertain capacity reserved: %s', async mode => {
    const f = fixture();
    if (mode === 'launch_failure') {
      vi.mocked(f.binding.startNativeHostCommand!).mockImplementation(() => { throw new Error('launch uncertain'); });
      expect(() => f.process.startCommand!(command)).toThrow('launch uncertain');
    } else {
      const process = f.process.startCommand!(command)!;
      if (mode === 'wait_failure') { f.completion.reject(new Error('reap unknown')); await expect(process.wait()).rejects.toThrow('reap unknown'); }
      else { f.completion.resolve(result(false)); await process.wait(); }
    }
    expect(f.resources.snapshot()).toEqual({ groups: 1, memoryBytes: 2048, processes: 128 });
  });

  it('drains an unobserved process and shares one native wait across callers', async () => {
    const f = fixture(); const process = f.process.startDuplex!(command)!;
    expect(process.wait()).toBe(process.wait()); expect(f.owner.wait).toHaveBeenCalledTimes(1);
    f.completion.resolve(result()); await process.wait(); expect(f.resources.snapshot().groups).toBe(0);
  });

  it('rejects stale packages and malformed limits before invoking native code', () => {
    const f = fixture();
    for (const resourceBounds of [undefined, { ...bounds, version: 2 }, { ...bounds, commandProcesses: NaN }, { ...bounds, duplexMemoryBytes: 0 }]) {
      const binding = { ...f.binding, nativeHostBridgeAbi: () => ({ resourceBounds }) } as NativeHostBridgeBinding;
      expect(() => f.resources.bind(binding)).toThrow('verified process resource bounds');
    }
    expect(() => new NativeTreeResources(f.ctrl.signal, { memoryBytes: Infinity, processes: 1 })).toThrow('Invalid');
    expect(f.binding.startNativeHostCommand).not.toHaveBeenCalled();
  });

  it('cancellation refuses new starts without prematurely releasing live owners', async () => {
    const f = fixture(); const owner = f.process.startCommand!(command)!; f.ctrl.abort(new Error('tree closed'));
    expect(() => f.process.reserveRuntime()).toThrow('tree closed');
    expect(() => f.process.startDuplex!(command)).toThrow('tree closed');
    expect(f.resources.snapshot().groups).toBe(1);
    f.completion.resolve(result()); await owner.wait(); expect(f.resources.snapshot().groups).toBe(0);
  });
});
