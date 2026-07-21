import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadDebugAdapter: vi.fn(),
  reserveLoopbackPort: vi.fn(),
  startDebugAdapter: vi.fn(),
  startDebugTarget: vi.fn(),
  terminateDebuggeeTree: vi.fn(),
}));

vi.mock('@mcp/plugin-host', () => ({
  isFirstPartyBundledDebugger: () => true,
  listDebuggerPlugins: () => [],
  loadDebugAdapter: mocks.loadDebugAdapter,
}));

vi.mock('../adapter-process.js', () => ({
  reserveLoopbackPort: mocks.reserveLoopbackPort,
  startDebugAdapter: mocks.startDebugAdapter,
  startDebugTarget: mocks.startDebugTarget,
  terminateDebuggeeTree: mocks.terminateDebuggeeTree,
}));

import { DebugSessionManager } from '../session-manager.js';

type EventListener = (body: any) => void;
type CloseListener = (error?: Error) => void;
type RequestHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

class FakeDap {
  readonly events = new Map<string, Set<EventListener>>();
  readonly closeListeners = new Set<CloseListener>();
  readonly reverseRequests = new Map<string, RequestHandler>();
  closed = false;
  requestHook: (command: string, args: Record<string, unknown>) => Promise<unknown> = async () => ({});

  async request<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) throw new Error('DAP connection is closed');
    return this.requestHook(command, args) as Promise<T>;
  }

  async waitForEvent<T>(): Promise<T> {
    return {} as T;
  }

  onEvent<T>(event: string, listener: (body: T) => void): () => void {
    const listeners = this.events.get(event) ?? new Set();
    listeners.add(listener as EventListener);
    this.events.set(event, listeners);
    return () => listeners.delete(listener as EventListener);
  }

  onClose(listener: CloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onRequest(command: string, handler: RequestHandler): () => void {
    this.reverseRequests.set(command, handler);
    return () => this.reverseRequests.delete(command);
  }

  emit(event: string, body: unknown): void {
    for (const listener of this.events.get(event) ?? []) listener(body);
  }

  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener(error);
  }
}

function loadedAdapter() {
  return {
    namespace: 'javascript-debugger',
    pluginRoot: 'C:\\plugins\\javascript-debugger',
    contribution: { id: 'javascript' },
    runtime: {
      sdkVersion: 1,
      id: 'javascript',
      resolveAdapter: () => ({ command: 'node', transport: { kind: 'stdio' } }),
      resolveConfiguration: () => ({ type: 'pwa-node', request: 'launch' }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadDebugAdapter.mockResolvedValue(loadedAdapter());
  mocks.reserveLoopbackPort.mockResolvedValue({ port: 9411, release: vi.fn().mockResolvedValue(undefined) });
  mocks.startDebugTarget.mockResolvedValue({ child: { pid: 7654 }, dispose: vi.fn().mockResolvedValue(undefined) });
  mocks.terminateDebuggeeTree.mockResolvedValue(undefined);
});

describe('DebugSessionManager lifecycle', () => {
  it('preserves the launch failure through disposal and cleans the reported debuggee PID', async () => {
    const parent = new FakeDap();
    parent.requestHook = async (command) => {
      if (command === 'initialize') {
        parent.emit('process', { systemProcessId: 4321, isLocalProcess: true });
        return {};
      }
      if (command === 'launch') throw new Error('Wrangler Inspector did not listen on 127.0.0.1:9411');
      if (command === 'disconnect') {
        parent.close();
        return {};
      }
      return {};
    };
    const dispose = vi.fn(async () => parent.close());
    mocks.startDebugAdapter.mockResolvedValue({
      dap: parent,
      connectSession: vi.fn(),
      diagnostics: () => ({ stdout: '', stderr: 'adapter diagnostic' }),
      dispose,
    });

    const manager = new DebugSessionManager();
    await expect(manager.start(7, 'C:\\project', {
      projectId: 7,
      adapterId: 'javascript',
      request: 'launch',
      runner: { manager: 'yarn', script: 'dev' },
    })).rejects.toThrow('Wrangler Inspector did not listen');

    expect(manager.list()[0]).toMatchObject({
      state: 'error',
      error: 'Wrangler Inspector did not listen on 127.0.0.1:9411',
      output: [{ category: 'stderr', output: 'adapter diagnostic' }],
    });
    expect(dispose).toHaveBeenCalled();
    expect(mocks.terminateDebuggeeTree).toHaveBeenCalledWith(4321);
  });

  it('keeps the session running when a superseded bootstrap connection closes', async () => {
    const parent = new FakeDap();
    const child = new FakeDap();
    child.requestHook = async () => ({});
    parent.requestHook = async (command) => {
      if (command === 'launch') {
        const startChild = parent.reverseRequests.get('startDebugging');
        expect(startChild).toBeDefined();
        await startChild?.({ request: 'attach', configuration: { request: 'attach', type: 'pwa-node' } });
        parent.close();
      }
      return {};
    };
    const dispose = vi.fn(async () => {
      parent.close();
      child.close();
    });
    mocks.startDebugAdapter.mockResolvedValue({
      dap: parent,
      connectSession: vi.fn().mockResolvedValue(child),
      diagnostics: () => ({ stdout: '', stderr: '' }),
      dispose,
    });

    const manager = new DebugSessionManager();
    const started = await manager.start(8, 'C:\\project', {
      projectId: 8,
      adapterId: 'javascript',
      request: 'launch',
      runner: { manager: 'yarn', script: 'dev' },
    });

    expect(started.state).toBe('running');
    expect(started.error).toBeUndefined();
    await manager.stop(started.sessionId);
    expect(manager.list()[0]?.state).toBe('terminated');
  });

  it('launches a host-owned Wrangler target and sends a DAP attach request', async () => {
    const parent = new FakeDap();
    const requests: Array<{ command: string; args: Record<string, unknown> }> = [];
    parent.requestHook = async (command, args) => {
      requests.push({ command, args });
      if (command === 'setBreakpoints') {
        return { breakpoints: [{ id: 1, verified: false, message: 'Unbound breakpoint' }] };
      }
      return {};
    };
    const targetDispose = vi.fn().mockResolvedValue(undefined);
    mocks.startDebugTarget.mockResolvedValue({ child: { pid: 7654 }, dispose: targetDispose });
    mocks.loadDebugAdapter.mockResolvedValue({
      ...loadedAdapter(),
      runtime: {
        ...loadedAdapter().runtime,
        resolveConfiguration: () => ({
          dapRequest: 'attach',
          configuration: { type: 'pwa-node', request: 'attach', port: 9411 },
          target: { command: 'yarn', args: ['run', 'dev', '--inspector-port=9411'] },
        }),
      },
    });
    mocks.startDebugAdapter.mockResolvedValue({
      dap: parent,
      connectSession: vi.fn(),
      diagnostics: () => ({ stdout: '', stderr: '' }),
      dispose: vi.fn(async () => parent.close()),
    });

    const manager = new DebugSessionManager();
    const started = await manager.start(9, 'C:\\project', {
      projectId: 9,
      adapterId: 'javascript',
      request: 'launch',
      runner: { manager: 'yarn', script: 'dev' },
      breakpoints: [{ path: 'src/index.ts', breakpoints: [{ line: 24 }] }],
    });

    expect(mocks.startDebugTarget).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'yarn' }),
      expect.any(Function),
    );
    expect(requests).toContainEqual({
      command: 'attach',
      args: expect.objectContaining({ request: 'attach', port: 9411 }),
    });
    expect(manager.list()[0]?.breakpoints).toEqual([
      expect.objectContaining({ id: 1, verified: false, path: 'src/index.ts', requestedLine: 24 }),
    ]);
    parent.emit('breakpoint', {
      reason: 'changed',
      breakpoint: { id: 1, verified: true, line: 25, source: { path: 'C:\\project\\src\\index.ts' } },
    });
    expect(manager.list()[0]?.breakpoints).toEqual([
      expect.objectContaining({ id: 1, verified: true, path: 'src/index.ts', requestedLine: 24, line: 25 }),
    ]);
    await manager.stop(started.sessionId);
    expect(targetDispose).toHaveBeenCalledTimes(1);
  });
});
