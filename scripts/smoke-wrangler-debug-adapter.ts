import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import {
  reserveLoopbackPort,
  startDebugAdapter,
  startDebugTarget,
  terminateDebuggeeTree,
} from '../packages/api-handlers/src/debug/adapter-process.js';
import type { DapConnection } from '../packages/api-handlers/src/debug/dap-connection.js';
import { isDebugResolvedConfiguration } from '../packages/plugin-sdk/src/debug-adapter.js';
import { debugAdapter } from '../extensions/javascript-debugger/src/plugin.js';

interface StoppedEvent {
  reason: string;
  threadId: number;
}

async function main(): Promise<void> {
  const wranglerEntry = process.env.MCP_SMOKE_WRANGLER_ENTRY;
  if (!wranglerEntry || !existsSync(wranglerEntry)) {
    throw new Error('MCP_SMOKE_WRANGLER_ENTRY must point to wrangler/bin/wrangler.js');
  }

  const projectRoot = await mkdtemp(join(tmpdir(), 'mcp-wrangler-debug-smoke-'));
  const sourceDir = join(projectRoot, 'src');
  const source = join(sourceDir, 'index.ts');
  const appPort = await reserveLoopbackPort('127.0.0.1');
  const inspectorPort = await reserveLoopbackPort('127.0.0.1');
  const ownedPids = new Set<number>();
  const dapOutput: string[] = [];
  let breakpointResult: Array<{ verified: boolean; line?: number; message?: string }> = [];
  const breakpointEvents: Array<{ reason?: string; breakpoint?: { verified?: boolean; line?: number; message?: string } }> = [];
  let started: Awaited<ReturnType<typeof startDebugAdapter>> | null = null;
  let targetProcess: Awaited<ReturnType<typeof startDebugTarget>> | null = null;
  let requestActive = true;

  try {
    const packageBin = join(dirname(dirname(wranglerEntry)), '..', '.bin');
    const wranglerBinDir = existsSync(join(packageBin, process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler'))
      ? packageBin
      : dirname(dirname(dirname(wranglerEntry)));
    await mkdir(sourceDir, { recursive: true });
    await writeFile(source, [
      'export default {',
      '  async fetch(): Promise<Response> {',
      '    const base = 41;',
      '    const answer = base + 1;',
      '    return new Response(String(answer));',
      '  },',
      '};',
    ].join('\n'));
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
      name: 'mcp-wrangler-debug-smoke',
      private: true,
      scripts: { dev: `wrangler dev --ip 127.0.0.1 --port ${appPort.port}` },
    }, null, 2));
    await writeFile(join(projectRoot, 'wrangler.jsonc'), JSON.stringify({
      name: 'mcp-wrangler-debug-smoke',
      main: 'src/index.ts',
      compatibility_date: '2026-04-22',
    }, null, 2));

    const pluginRoot = process.env.MCP_SMOKE_DEBUG_PLUGIN_ROOT
      ? resolve(process.env.MCP_SMOKE_DEBUG_PLUGIN_ROOT)
      : resolve('dist', 'bundled-plugins', 'javascript-debugger');
    const executable = debugAdapter.resolveAdapter({
      pluginRoot,
      projectRoot,
      platform: process.platform,
      nodePath: process.env.MCP_SMOKE_DEBUG_NODE_PATH ?? process.execPath,
    });
    started = await startDebugAdapter(executable);
    const sourceBreakpoints = {
      source: { name: 'index.ts', path: source },
      breakpoints: [{ line: 4 }],
      sourceModified: false,
    };
    const stoppedQueue: StoppedEvent[] = [];
    const stoppedWaiters: Array<(event: StoppedEvent) => void> = [];
    let target = started.dap;

    const nextStopped = () => new Promise<StoppedEvent>((resolveStopped) => {
      const queued = stoppedQueue.shift();
      if (queued) resolveStopped(queued);
      else stoppedWaiters.push(resolveStopped);
    });
    const wire = (dap: DapConnection) => {
      dap.onEvent<{ output?: string }>('output', (body) => {
        if (body?.output) dapOutput.push(body.output);
      });
      dap.onEvent<{ systemProcessId?: number }>('process', (body) => {
        if (Number.isSafeInteger(body?.systemProcessId) && (body.systemProcessId ?? 0) > 0) {
          ownedPids.add(body.systemProcessId!);
        }
      });
      dap.onEvent<StoppedEvent>('stopped', (body) => {
        const waiter = stoppedWaiters.shift();
        if (waiter) waiter(body);
        else stoppedQueue.push(body);
      });
      dap.onEvent<{ reason?: string; breakpoint?: { verified?: boolean; line?: number; message?: string } }>('breakpoint', (body) => {
        breakpointEvents.push(body);
      });
    };
    wire(started.dap);

    const initializeArgs = {
      clientID: 'mcp-wrangler-smoke',
      clientName: 'MCP Wrangler debugger smoke',
      adapterID: 'javascript',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
      supportsVariableType: true,
      supportsVariablePaging: true,
      supportsRunInTerminalRequest: false,
      supportsStartDebuggingRequest: true,
    };
    const wireStartDebugging = (dap: DapConnection) => {
      dap.onRequest('startDebugging', async (args) => {
        const configuration = args.configuration as Record<string, unknown> | undefined;
        if (!configuration) throw new Error('startDebugging omitted configuration');
        const child = await started!.connectSession();
        target = child;
        wire(child);
        wireStartDebugging(child);
        const initialized = child.waitForEvent('initialized', 15_000);
        await child.request('initialize', initializeArgs);
        const request = args.request === 'attach' || configuration.request === 'attach' ? 'attach' : 'launch';
        const launch = child.request(request, configuration, 60_000);
        void launch.catch(() => undefined);
        await initialized;
        await child.request('setBreakpoints', sourceBreakpoints);
        await child.request('configurationDone');
        await launch;
        return {};
      });
    };
    wireStartDebugging(started.dap);

    const resolvedConfiguration = debugAdapter.resolveConfiguration({
      request: 'launch',
      projectRoot,
      targetPort: inspectorPort.port,
      runner: {
        manager: 'npm',
        script: 'dev',
        cwd: projectRoot,
        env: {
          PATH: `${wranglerBinDir}${delimiter}${process.env.PATH ?? ''}`,
        },
      },
      name: 'MCP Wrangler debugger smoke',
    });
    if (!isDebugResolvedConfiguration(resolvedConfiguration) || !resolvedConfiguration.target) {
      throw new Error('Wrangler did not resolve to a host-owned attach target');
    }
    const initialized = started.dap.waitForEvent('initialized', 15_000);
    await started.dap.request('initialize', initializeArgs);
    await Promise.all([appPort.release(), inspectorPort.release()]);
    let resolveReady!: () => void;
    const targetReady = new Promise<void>((resolveTargetReady) => { resolveReady = resolveTargetReady; });
    targetProcess = await startDebugTarget(resolvedConfiguration.target, (_category, output) => {
      dapOutput.push(output);
      if (output.includes('Ready on http://')) resolveReady();
    });
    const launch = started.dap.request(
      resolvedConfiguration.dapRequest,
      resolvedConfiguration.configuration,
      60_000,
    );
    void launch.catch(() => undefined);
    await initialized;
    const set = await started.dap.request<{ breakpoints: Array<{ verified: boolean; line?: number; message?: string }> }>(
      'setBreakpoints',
      sourceBreakpoints,
    );
    breakpointResult = set.breakpoints;
    await started.dap.request('configurationDone');
    await launch;
    await Promise.race([
      targetReady,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Wrangler target did not become ready')), 30_000)),
    ]);
    breakpointResult = (await target.request<{ breakpoints: typeof breakpointResult }>(
      'setBreakpoints',
      sourceBreakpoints,
    )).breakpoints;

    // Workerd publishes the Worker script to CDP lazily on its first request.
    // That request binds the provisional source breakpoint; the following
    // request is the first one that can be expected to pause on it.
    if (!breakpointResult[0]?.verified) {
      const warmup = await fetch(`http://127.0.0.1:${appPort.port}/`);
      await warmup.text();
      const verificationDeadline = Date.now() + 10_000;
      while (!breakpointEvents.some((event) => event.breakpoint?.verified)) {
        if (Date.now() >= verificationDeadline) throw new Error('Wrangler breakpoint did not become verified');
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      const verified = [...breakpointEvents].reverse().find((event) => event.breakpoint?.verified)?.breakpoint;
      if (verified) breakpointResult = [{ ...breakpointResult[0], ...verified, verified: true }];
    }

    const responsePromise = (async () => {
      while (requestActive) {
        try {
          return await fetch(`http://127.0.0.1:${appPort.port}/`);
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
      }
      throw new Error('Wrangler request cancelled');
    })();
    void responsePromise.catch(() => undefined);
    const pause = await Promise.race([
      nextStopped(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Wrangler target did not stop')), 30_000)),
    ]);
    const stack = await target.request<{ stackFrames: Array<{ id: number; line: number }> }>('stackTrace', {
      threadId: pause.threadId,
      startFrame: 0,
      levels: 20,
    });
    const top = stack.stackFrames[0];
    if (!top || top.line !== 4) throw new Error(`expected to pause on line 4, got ${top?.line ?? 'no frame'}`);
    const evaluated = await target.request<{ result: string }>('evaluate', {
      expression: 'base + 1',
      frameId: top.id,
      context: 'repl',
    });
    if (evaluated.result !== '42') throw new Error(`expected base + 1 = 42, got ${evaluated.result}`);
    await target.request('continue', { threadId: pause.threadId });
    const response = await responsePromise;
    const body = await response.text();
    if (body !== '42') throw new Error(`expected Worker response 42, got ${body}`);
    await started.dap.request('disconnect', {
      restart: false,
      terminateDebuggee: true,
      suspendDebuggee: false,
    }, 5_000).catch(() => undefined);

    console.log(JSON.stringify({
      initialized: true,
      childSession: target !== started!.dap,
      inspectorPort: inspectorPort.port,
      breakpointVerified: breakpointResult[0]?.verified ?? false,
      pausedLine: top.line,
      evaluated: evaluated.result,
      response: body,
      disconnected: true,
    }));
  } catch (error) {
    console.error(JSON.stringify({ dapOutput, breakpointResult, breakpointEvents, diagnostics: started?.diagnostics() }));
    throw error;
  } finally {
    requestActive = false;
    await appPort.release().catch(() => undefined);
    await inspectorPort.release().catch(() => undefined);
    await targetProcess?.dispose().catch(() => undefined);
    await started?.dispose().catch(() => undefined);
    await Promise.allSettled([...ownedPids].map((pid) => terminateDebuggeeTree(pid)));
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
