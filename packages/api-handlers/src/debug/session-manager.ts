import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import type {
  DebugBreakpoint,
  DebugEvaluateResult,
  DebugOutputLine,
  DebugScope,
  DebugSessionBreakpoint,
  DebugSessionSummary,
  DebugSourceBreakpoints,
  DebugStackFrame,
  DebugStartInput,
  DebugThread,
  DebugVariable,
} from '@mcp/api-bus';
import {
  isDebugResolvedConfiguration,
  type DebugConfigurationInput,
} from '@mcp/plugin-sdk';
import {
  isFirstPartyBundledDebugger,
  listDebuggerPlugins,
  loadDebugAdapter,
  type LoadedDebugAdapter,
} from '@mcp/plugin-host';
import {
  reserveLoopbackPort,
  startDebugAdapter,
  startDebugTarget,
  terminateDebuggeeTree,
  type ReservedLoopbackPort,
  type StartedDebugAdapter,
  type StartedDebugTarget,
} from './adapter-process.js';
import type { DapConnection } from './dap-connection.js';

const OUTPUT_LIMIT = 200;
const CHILD_CONFIGURATION_KEYS = [
  'sourceMaps',
  'pauseForSourceMap',
  'mcpPrimeOnFirstDebuggerStatement',
  'resolveSourceMapLocations',
  'runtimeSourcemapPausePatterns',
  'sourceMapPathOverrides',
  'rootPath',
  'outFiles',
  'skipFiles',
  'smartStep',
  'enableContentValidation',
  'localRoot',
  'remoteRoot',
  'cwd',
  'autoAttachChildProcesses',
  'attachExistingChildren',
] as const;

function childConfigurationDefaults(configuration: Record<string, unknown>): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const key of CHILD_CONFIGURATION_KEYS) {
    if (configuration[key] !== undefined) defaults[key] = configuration[key];
  }
  return defaults;
}

interface DebugSessionRecord {
  summary: DebugSessionSummary;
  adapter: StartedDebugAdapter | null;
  target: StartedDebugTarget | null;
  loaded: LoadedDebugAdapter | null;
  controlDap: DapConnection | null;
  initializeArgs: Record<string, unknown> | null;
  projectRoot: string;
  initialBreakpoints: DebugSourceBreakpoints[];
  request: 'launch' | 'attach';
  dapRequest: 'launch' | 'attach';
  childConfigurationDefaults: Record<string, unknown>;
  ownedProcessIds: Set<number>;
  breakpointBindings: Map<number, { path: string; requestedLine: number }>;
}

function cloneSummary(summary: DebugSessionSummary): DebugSessionSummary {
  return {
    ...summary,
    stopped: summary.stopped ? { ...summary.stopped } : undefined,
    output: summary.output.map((line) => ({ ...line })),
    breakpoints: summary.breakpoints?.map((breakpoint) => ({
      ...breakpoint,
      source: breakpoint.source ? { ...breakpoint.source } : undefined,
    })),
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
        breakpoints: [],
      },
      adapter: null,
      target: null,
      loaded: null,
      controlDap: null,
      initializeArgs: null,
      projectRoot,
      initialBreakpoints: input.breakpoints ?? [],
      request: input.request ?? 'launch',
      dapRequest: input.request ?? 'launch',
      childConfigurationDefaults: {},
      ownedProcessIds: new Set(),
      breakpointBindings: new Map(),
    };
    this.sessions.set(sessionId, record);
    this.emit();

    let targetPort: ReservedLoopbackPort | null = null;
    try {
      const loaded = await loadDebugAdapter(input.adapterId);
      record.loaded = loaded;
      if (record.request === 'launch') targetPort = await reserveLoopbackPort('127.0.0.1');
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
        targetPort: targetPort?.port,
        configuration: input.configuration,
      };
      const executable = loaded.runtime.resolveAdapter({
        pluginRoot: loaded.pluginRoot,
        projectRoot,
        platform: process.platform,
        nodePath: process.execPath,
      });
      const resolved = loaded.runtime.resolveConfiguration(configurationInput);
      const configuration = isDebugResolvedConfiguration(resolved) ? resolved.configuration : resolved;
      record.dapRequest = isDebugResolvedConfiguration(resolved) ? resolved.dapRequest : record.request;
      record.childConfigurationDefaults = childConfigurationDefaults(configuration);
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
      await targetPort?.release();
      targetPort = null;
      if (isDebugResolvedConfiguration(resolved) && resolved.target) {
        record.target = await startDebugTarget(resolved.target, (category, output) => {
          this.appendOutput(record, { category, output, timestamp: Date.now() });
        });
        // Wrangler opens the inspector before Workerd has published the Worker
        // target. Attaching earlier leaves breakpoints provisional until the
        // first request, so that request cannot pause. Wait for explicit target
        // readiness and attach only after the runtime is fully available.
        await record.target.ready;
      }
      const launch = adapter.dap.request(record.dapRequest, configuration, 60_000);
      void launch.catch(() => undefined);
      await initialized;
      for (const source of input.breakpoints ?? []) await this.setBreakpoints(sessionId, projectRoot, source);
      await adapter.dap.request('configurationDone', {});
      await launch;
      if (record.summary.state === 'configuring') record.summary.state = 'running';
      this.emit();
      return cloneSummary(record.summary);
    } catch (error) {
      await targetPort?.release().catch(() => undefined);
      targetPort = null;
      this.appendAdapterDiagnostics(record);
      record.summary.state = 'error';
      record.summary.error = error instanceof Error ? error.message : String(error);
      this.emit();
      await record.adapter?.dap.request('disconnect', {
        restart: false,
        terminateDebuggee: true,
        suspendDebuggee: false,
      }, 1_000).catch(() => undefined);
      await record.adapter?.dispose().catch(() => undefined);
      record.adapter = null;
      await this.cleanupTarget(record);
      await this.cleanupOwnedProcesses(record);
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
      await this.cleanupTarget(record);
      await this.cleanupOwnedProcesses(record);
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
      { path: source.path, breakpoints: source.breakpoints.map((breakpoint) => ({ ...breakpoint })) },
    ];
    return this.sendBreakpoints(record, this.controlConnection(record), path, source);
  }

  private async sendBreakpoints(
    record: DebugSessionRecord,
    dap: DapConnection,
    path: string,
    source: DebugSourceBreakpoints,
  ): Promise<DebugBreakpoint[]> {
    const response = await dap.request<{ breakpoints?: DebugBreakpoint[] }>('setBreakpoints', {
      source: { name: path.split(/[\\/]/).pop(), path },
      breakpoints: source.breakpoints,
      sourceModified: false,
    });
    const breakpoints = response?.breakpoints ?? [];
    this.recordBreakpointResults(record, source.path, source.breakpoints, breakpoints);
    return breakpoints;
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
    dap.onEvent<{ systemProcessId?: number; isLocalProcess?: boolean }>('process', (body) => {
      if (
        record.request === 'launch' &&
        body?.isLocalProcess !== false &&
        Number.isSafeInteger(body?.systemProcessId) &&
        (body.systemProcessId ?? 0) > 0
      ) {
        record.ownedProcessIds.add(body.systemProcessId!);
      }
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
    dap.onEvent<{ reason?: 'new' | 'changed' | 'removed'; breakpoint?: DebugBreakpoint }>('breakpoint', (body) => {
      const breakpoint = body?.breakpoint;
      if (!breakpoint || !Number.isSafeInteger(breakpoint.id)) return;
      const binding = record.breakpointBindings.get(breakpoint.id!);
      if (!binding) return;
      if (body.reason === 'removed') {
        record.breakpointBindings.delete(breakpoint.id!);
        record.summary.breakpoints = (record.summary.breakpoints ?? []).filter((item) => item.id !== breakpoint.id);
      } else {
        const updated: DebugSessionBreakpoint = {
          ...breakpoint,
          path: binding.path,
          requestedLine: binding.requestedLine,
        };
        const current = record.summary.breakpoints ?? [];
        const index = current.findIndex((item) => item.id === breakpoint.id);
        record.summary.breakpoints = index < 0
          ? [...current, updated]
          : current.map((item, itemIndex) => itemIndex === index ? updated : item);
      }
      this.emit();
    });
    dap.onEvent('terminated', () => {
      if (record.controlDap !== dap) return;
      record.summary.state = 'terminated';
      record.summary.stopped = undefined;
      this.emit();
      void adapter.dispose().catch(() => undefined).finally(() => {
        if (record.adapter === adapter) record.adapter = null;
        void this.cleanupTarget(record);
        void this.cleanupOwnedProcesses(record);
      });
    });
    dap.onClose((error) => {
      if (['terminated', 'terminating', 'error'].includes(record.summary.state)) return;
      // js-debug uses the first TCP connection as a bootstrap/controller and
      // can hand control to a child DAP session through `startDebugging`.
      // Closing that superseded bootstrap connection is not a session failure.
      if (record.controlDap !== dap) return;
      this.appendAdapterDiagnostics(record);
      record.summary.state = 'error';
      record.summary.error = error?.message ?? 'debug adapter connection closed';
      this.emit();
      void adapter.dispose().catch(() => undefined).finally(() => {
        if (record.adapter === adapter) record.adapter = null;
        void this.cleanupTarget(record);
        void this.cleanupOwnedProcesses(record);
      });
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
    const requestedConfiguration = args.configuration;
    if (!requestedConfiguration || typeof requestedConfiguration !== 'object' || Array.isArray(requestedConfiguration)) {
      throw new Error('startDebugging requires a configuration object');
    }
    // js-debug's Workerd handoff contains only the pending target identity.
    // VS Code normally resolves/inherits the parent launch settings before it
    // opens this child session. Since MCP is the DAP client, carry the safe
    // source-map and breakpoint settings across that boundary ourselves.
    const configuration = {
      ...record.childConfigurationDefaults,
      ...(requestedConfiguration as Record<string, unknown>),
    };
    const request = args.request === 'attach' || configuration.request === 'attach'
      ? 'attach'
      : 'launch';
    const child = await record.adapter.connectSession();
    record.controlDap = child;
    this.wireEvents(record, child);
    this.wireReverseRequests(record, child);

    const initialized = child.waitForEvent('initialized', 15_000);
    await child.request('initialize', record.initializeArgs);
    const launch = child.request(request, configuration, 60_000);
    void launch.catch((error) => this.handleAsyncLaunchFailure(record, child, error));
    await initialized;
    for (const source of record.initialBreakpoints) {
      const path = projectPath(record.projectRoot, source.path, record.projectRoot);
      await this.sendBreakpoints(record, child, path, source);
    }
    await child.request('configurationDone', {});
    // A Workerd target is materialized by the first HTTP request. Waiting for
    // the child attach here prevents js-debug from answering the parent's
    // `startDebugging` request, which in turn prevents the session from ever
    // reaching the running state where that HTTP request can be made.
    return {};
  }

  private handleAsyncLaunchFailure(record: DebugSessionRecord, dap: DapConnection, error: unknown): void {
    if (record.controlDap !== dap || ['terminated', 'terminating', 'error'].includes(record.summary.state)) return;
    const adapter = record.adapter;
    this.appendAdapterDiagnostics(record);
    record.summary.state = 'error';
    record.summary.error = error instanceof Error ? error.message : String(error);
    this.emit();
    void adapter?.dispose().catch(() => undefined).finally(() => {
      if (record.adapter === adapter) record.adapter = null;
      void this.cleanupTarget(record);
      void this.cleanupOwnedProcesses(record);
    });
  }

  private emit(): void {
    this.bus.push(this.list());
  }

  private appendOutput(record: DebugSessionRecord, line: DebugOutputLine): void {
    record.summary.output.push(line);
    if (record.summary.output.length > OUTPUT_LIMIT) {
      record.summary.output.splice(0, record.summary.output.length - OUTPUT_LIMIT);
    }
    this.emit();
  }

  private appendAdapterDiagnostics(record: DebugSessionRecord): void {
    const diagnostics = record.adapter?.diagnostics();
    if (!diagnostics) return;
    for (const [category, output] of Object.entries(diagnostics) as Array<['stdout' | 'stderr', string]>) {
      const trimmed = output.trim();
      if (!trimmed || record.summary.output.some((line) => line.category === category && line.output.trim() === trimmed)) continue;
      record.summary.output.push({ category, output: trimmed, timestamp: Date.now() });
    }
    if (record.summary.output.length > OUTPUT_LIMIT) {
      record.summary.output.splice(0, record.summary.output.length - OUTPUT_LIMIT);
    }
  }

  private recordBreakpointResults(
    record: DebugSessionRecord,
    path: string,
    requested: DebugSourceBreakpoints['breakpoints'],
    resolved: DebugBreakpoint[],
  ): void {
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    for (const [id, binding] of record.breakpointBindings) {
      const bindingKey = process.platform === 'win32' ? binding.path.toLowerCase() : binding.path;
      if (bindingKey === key) record.breakpointBindings.delete(id);
    }
    const items = requested.map((sourceBreakpoint, index): DebugSessionBreakpoint => {
      const result = resolved[index] ?? { verified: false };
      if (Number.isSafeInteger(result.id)) {
        record.breakpointBindings.set(result.id!, { path, requestedLine: sourceBreakpoint.line });
      }
      return { ...result, path, requestedLine: sourceBreakpoint.line };
    });
    record.summary.breakpoints = [
      ...(record.summary.breakpoints ?? []).filter((item) => {
        const itemKey = process.platform === 'win32' ? item.path.toLowerCase() : item.path;
        return itemKey !== key;
      }),
      ...items,
    ];
    this.emit();
  }

  private async cleanupOwnedProcesses(record: DebugSessionRecord): Promise<void> {
    if (record.request !== 'launch' || record.ownedProcessIds.size === 0) return;
    const pids = [...record.ownedProcessIds];
    record.ownedProcessIds.clear();
    await Promise.allSettled(pids.map((pid) => terminateDebuggeeTree(pid)));
  }

  private async cleanupTarget(record: DebugSessionRecord): Promise<void> {
    const target = record.target;
    record.target = null;
    await target?.dispose().catch(() => undefined);
  }
}
