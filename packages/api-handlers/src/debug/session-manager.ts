import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import type {
  DebugBreakpoint,
  DebugEvaluateResult,
  DebugOutputLine,
  DebugScope,
  DebugSessionSummary,
  DebugSourceBreakpoints,
  DebugStackFrame,
  DebugStartInput,
  DebugThread,
  DebugVariable,
} from '@mcp/api-bus';
import type { DebugConfigurationInput } from '@mcp/plugin-sdk';
import {
  isFirstPartyBundledDebugger,
  listDebuggerPlugins,
  loadDebugAdapter,
  type LoadedDebugAdapter,
} from '@mcp/plugin-host';
import { startDebugAdapter, type StartedDebugAdapter } from './adapter-process.js';
import type { DapConnection } from './dap-connection.js';

const OUTPUT_LIMIT = 200;

interface DebugSessionRecord {
  summary: DebugSessionSummary;
  adapter: StartedDebugAdapter | null;
  loaded: LoadedDebugAdapter | null;
  controlDap: DapConnection | null;
  initializeArgs: Record<string, unknown> | null;
  projectRoot: string;
  initialBreakpoints: DebugSourceBreakpoints[];
}

function cloneSummary(summary: DebugSessionSummary): DebugSessionSummary {
  return {
    ...summary,
    stopped: summary.stopped ? { ...summary.stopped } : undefined,
    output: summary.output.map((line) => ({ ...line })),
  };
}

function projectPath(root: string, value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const absolute = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const rel = relative(root, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`debug path escapes the project: ${value}`);
  return absolute;
}

class SnapshotBus {
  private readonly subscribers = new Set<(snapshot: DebugSessionSummary[]) => void>();

  push(snapshot: DebugSessionSummary[]): void {
    for (const subscriber of this.subscribers) subscriber(snapshot);
  }

  iterable(initial: DebugSessionSummary[]): AsyncIterable<DebugSessionSummary[]> {
    const subscribers = this.subscribers;
    return {
      [Symbol.asyncIterator](): AsyncIterator<DebugSessionSummary[]> {
        const queue: DebugSessionSummary[][] = [initial];
        const waiters: Array<(result: IteratorResult<DebugSessionSummary[]>) => void> = [];
        const onSnapshot = (snapshot: DebugSessionSummary[]) => {
          const waiter = waiters.shift();
          if (waiter) waiter({ value: snapshot, done: false });
          else queue.push(snapshot);
        };
        subscribers.add(onSnapshot);
        return {
          async next() {
            if (queue.length) return { value: queue.shift()!, done: false };
            return new Promise((resolve) => waiters.push(resolve));
          },
          async return() {
            subscribers.delete(onSnapshot);
            return { value: undefined as never, done: true };
          },
        };
      },
    };
  }
}

export class DebugSessionManager {
  private readonly sessions = new Map<string, DebugSessionRecord>();
  private readonly bus = new SnapshotBus();

  adapters() {
    return listDebuggerPlugins().flatMap((ref) => ref.debuggers.map((definition) => ({
      ...definition,
      namespace: ref.namespace,
      executable: isFirstPartyBundledDebugger(ref) && Boolean(ref.runtime?.adapters.includes(definition.id)),
    })));
  }

  list(): DebugSessionSummary[] {
    return [...this.sessions.values()].map((session) => cloneSummary(session.summary));
  }

  events(): AsyncIterable<DebugSessionSummary[]> {
    return this.bus.iterable(this.list());
  }

  async start(projectId: number, projectRoot: string, input: DebugStartInput): Promise<DebugSessionSummary> {
    const sessionId = randomUUID();
    const record: DebugSessionRecord = {
      summary: {
        sessionId,
        projectId,
        adapterId: input.adapterId,
        name: input.name ?? `Debug ${input.adapterId}`,
        state: 'starting',
        startedAt: Date.now(),
        output: [],
      },
      adapter: null,
      loaded: null,
      controlDap: null,
      initializeArgs: null,
      projectRoot,
      initialBreakpoints: input.breakpoints ?? [],
    };
    this.sessions.set(sessionId, record);
    this.emit();

    try {
      const loaded = await loadDebugAdapter(input.adapterId);
      record.loaded = loaded;
      const cwd = projectPath(projectRoot, input.cwd ?? input.runner?.cwd, projectRoot);
      const file = input.file ? projectPath(projectRoot, input.file, projectRoot) : undefined;
      const configurationInput: DebugConfigurationInput = {
        request: input.request ?? 'launch',
        name: input.name,
        projectRoot,
        file,
        args: input.args,
        cwd,
        env: input.env,
        runner: input.runner ? { ...input.runner, cwd } : undefined,
        configuration: input.configuration,
      };
      const executable = loaded.runtime.resolveAdapter({
        pluginRoot: loaded.pluginRoot,
        projectRoot,
        platform: process.platform,
        nodePath: process.execPath,
      });
      const configuration = loaded.runtime.resolveConfiguration(configurationInput);
      const adapter = await startDebugAdapter(executable);
      record.adapter = adapter;
      record.controlDap = adapter.dap;
      this.wireEvents(record, adapter.dap);
      this.wireReverseRequests(record, adapter.dap);

      record.summary.state = 'initializing';
      this.emit();
      const initializeArgs = {
        clientID: 'mcp-codestudio',
        clientName: 'MCP CodeStudio',
        adapterID: input.adapterId,
        locale: 'pt-BR',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
        supportsVariableType: true,
        supportsVariablePaging: true,
        supportsRunInTerminalRequest: false,
        supportsStartDebuggingRequest: true,
        supportsInvalidatedEvent: true,
        supportsMemoryReferences: false,
        supportsProgressReporting: true,
      };
      record.initializeArgs = initializeArgs;
      const initialized = adapter.dap.waitForEvent('initialized', 15_000);
      await adapter.dap.request('initialize', initializeArgs);

      record.summary.state = 'configuring';
      this.emit();
      const launch = adapter.dap.request(input.request ?? 'launch', configuration, 60_000);
      void launch.catch(() => undefined);
      await initialized;
      for (const source of input.breakpoints ?? []) await this.setBreakpoints(sessionId, projectRoot, source);
      await adapter.dap.request('configurationDone', {});
      await launch;
      if (record.summary.state === 'configuring') record.summary.state = 'running';
      this.emit();
      return cloneSummary(record.summary);
    } catch (error) {
      record.summary.state = 'error';
      record.summary.error = error instanceof Error ? error.message : String(error);
      this.emit();
      await record.adapter?.dispose().catch(() => undefined);
      record.adapter = null;
      throw error;
    }
  }

  async stop(sessionId: string): Promise<void> {
    const record = this.session(sessionId);
    if (record.summary.state === 'terminated') return;
    record.summary.state = 'terminating';
    this.emit();
    try {
      await record.adapter?.dap.request('disconnect', {
        restart: false,
        terminateDebuggee: true,
        suspendDebuggee: false,
      }, 3_000);
    } catch {
      // Hard cleanup below is authoritative even if the adapter no longer responds.
    } finally {
      await record.adapter?.dispose().catch(() => undefined);
      record.adapter = null;
      record.summary.state = 'terminated';
      this.emit();
    }
  }

  async control(sessionId: string, command: 'pause' | 'continue' | 'next' | 'stepIn' | 'stepOut', threadId: number): Promise<void> {
    const record = this.activeSession(sessionId);
    await this.controlConnection(record).request(command, { threadId });
    if (command !== 'pause') {
      record.summary.state = 'running';
      record.summary.stopped = undefined;
      this.emit();
    }
  }

  async setBreakpoints(
    sessionId: string,
    projectRoot: string,
    source: DebugSourceBreakpoints,
  ): Promise<DebugBreakpoint[]> {
    const record = this.activeSession(sessionId);
    const path = projectPath(projectRoot, source.path, projectRoot);
    record.initialBreakpoints = [
      ...record.initialBreakpoints.filter((existing) => projectPath(projectRoot, existing.path, projectRoot) !== path),
      { path, breakpoints: source.breakpoints.map((breakpoint) => ({ ...breakpoint })) },
    ];
    return this.sendBreakpoints(this.controlConnection(record), path, source);
  }

  private async sendBreakpoints(
    dap: DapConnection,
    path: string,
    source: DebugSourceBreakpoints,
  ): Promise<DebugBreakpoint[]> {
    const response = await dap.request<{ breakpoints?: DebugBreakpoint[] }>('setBreakpoints', {
      source: { name: path.split(/[\\/]/).pop(), path },
      breakpoints: source.breakpoints,
      sourceModified: false,
    });
    return response?.breakpoints ?? [];
  }

  async threads(sessionId: string): Promise<DebugThread[]> {
    const response = await this.controlConnection(this.activeSession(sessionId)).request<{ threads?: DebugThread[] }>('threads');
    return response?.threads ?? [];
  }

  async stackTrace(sessionId: string, threadId: number, startFrame?: number, levels?: number) {
    const response = await this.controlConnection(this.activeSession(sessionId)).request<{
      stackFrames?: DebugStackFrame[];
      totalFrames?: number;
    }>('stackTrace', { threadId, startFrame, levels });
    return { stackFrames: response?.stackFrames ?? [], totalFrames: response?.totalFrames };
  }

  async scopes(sessionId: string, frameId: number): Promise<DebugScope[]> {
    const response = await this.controlConnection(this.activeSession(sessionId)).request<{ scopes?: DebugScope[] }>('scopes', { frameId });
    return response?.scopes ?? [];
  }

  async variables(sessionId: string, variablesReference: number, start?: number, count?: number): Promise<DebugVariable[]> {
    const response = await this.controlConnection(this.activeSession(sessionId)).request<{ variables?: DebugVariable[] }>('variables', {
      variablesReference,
      start,
      count,
    });
    return response?.variables ?? [];
  }

  async evaluate(
    sessionId: string,
    expression: string,
    frameId?: number,
    context: 'watch' | 'repl' | 'hover' = 'repl',
  ): Promise<DebugEvaluateResult> {
    return this.controlConnection(this.activeSession(sessionId)).request<DebugEvaluateResult>('evaluate', {
      expression,
      frameId,
      context,
    });
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((sessionId) => this.stop(sessionId)));
  }

  private wireEvents(record: DebugSessionRecord, dap: DapConnection): void {
    const adapter = record.adapter!;
    dap.onEvent<DebugOutputLine>('output', (body) => {
      const line: DebugOutputLine = {
        category: body?.category,
        output: body?.output ?? '',
        timestamp: Date.now(),
      };
      record.summary.output.push(line);
      if (record.summary.output.length > OUTPUT_LIMIT) record.summary.output.splice(0, record.summary.output.length - OUTPUT_LIMIT);
      this.emit();
    });
    dap.onEvent('stopped', (body: any) => {
      record.controlDap = dap;
      record.summary.state = 'paused';
      record.summary.stopped = {
        reason: typeof body?.reason === 'string' ? body.reason : 'pause',
        description: typeof body?.description === 'string' ? body.description : undefined,
        threadId: typeof body?.threadId === 'number' ? body.threadId : undefined,
        allThreadsStopped: typeof body?.allThreadsStopped === 'boolean' ? body.allThreadsStopped : undefined,
      };
      this.emit();
    });
    dap.onEvent('continued', () => {
      record.summary.state = 'running';
      record.summary.stopped = undefined;
      this.emit();
    });
    dap.onEvent<{ exitCode?: number }>('exited', (body) => {
      if (typeof body?.exitCode === 'number') record.summary.exitCode = body.exitCode;
      this.emit();
    });
    dap.onEvent('terminated', () => {
      record.summary.state = 'terminated';
      record.summary.stopped = undefined;
      this.emit();
      void adapter.dispose().catch(() => undefined).finally(() => {
        if (record.adapter === adapter) record.adapter = null;
      });
    });
    dap.onClose((error) => {
      if (record.summary.state === 'terminated' || record.summary.state === 'terminating') return;
      record.summary.state = 'error';
      record.summary.error = error?.message ?? 'debug adapter connection closed';
      this.emit();
    });
  }

  private session(sessionId: string): DebugSessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error('debug session not found');
    return record;
  }

  private activeSession(sessionId: string): DebugSessionRecord {
    const record = this.session(sessionId);
    if (!record.adapter || record.summary.state === 'terminated' || record.summary.state === 'error') {
      throw new Error('debug session is not active');
    }
    return record;
  }

  private controlConnection(record: DebugSessionRecord): DapConnection {
    return record.controlDap ?? record.adapter!.dap;
  }

  private wireReverseRequests(record: DebugSessionRecord, dap: DapConnection): void {
    dap.onRequest('startDebugging', (args) => this.startChildSession(record, args));
  }

  private async startChildSession(
    record: DebugSessionRecord,
    args: Record<string, unknown>,
  ): Promise<Record<string, never>> {
    if (!record.adapter || !record.initializeArgs) throw new Error('parent debug session is not initialized');
    const configuration = args.configuration;
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
      throw new Error('startDebugging requires a configuration object');
    }
    const request = args.request === 'attach' || (configuration as Record<string, unknown>).request === 'attach'
      ? 'attach'
      : 'launch';
    const child = await record.adapter.connectSession();
    record.controlDap = child;
    this.wireEvents(record, child);
    this.wireReverseRequests(record, child);

    const initialized = child.waitForEvent('initialized', 15_000);
    await child.request('initialize', record.initializeArgs);
    const launch = child.request(request, configuration as Record<string, unknown>, 60_000);
    void launch.catch(() => undefined);
    await initialized;
    for (const source of record.initialBreakpoints) {
      const path = projectPath(record.projectRoot, source.path, record.projectRoot);
      await this.sendBreakpoints(child, path, source);
    }
    await child.request('configurationDone', {});
    await launch;
    return {};
  }

  private emit(): void {
    this.bus.push(this.list());
  }
}
