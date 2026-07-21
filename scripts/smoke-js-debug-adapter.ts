import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startDebugAdapter } from '../packages/api-handlers/src/debug/adapter-process.js';
import type { DapConnection } from '../packages/api-handlers/src/debug/dap-connection.js';
import { debugAdapter } from '../extensions/javascript-debugger/src/plugin.js';

interface StoppedEvent {
  reason: string;
  threadId: number;
}

async function main(): Promise<void> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'mcp-js-debug-smoke-'));
  const program = join(projectRoot, 'fixture.js');
  await writeFile(program, [
    'const base = 41;',
    'const answer = base + 1;',
    'console.log(answer);',
  ].join('\n'));

  const pluginRoot = process.env.MCP_SMOKE_DEBUG_PLUGIN_ROOT
    ? resolve(process.env.MCP_SMOKE_DEBUG_PLUGIN_ROOT)
    : resolve('dist', 'bundled-plugins', 'javascript-debugger');
  const executable = debugAdapter.resolveAdapter({
    pluginRoot,
    projectRoot,
    platform: process.platform,
    // Override lets CI reproduce the desktop path where process.execPath is
    // electron.exe rather than node.exe.
    nodePath: process.env.MCP_SMOKE_DEBUG_NODE_PATH ?? process.execPath,
  });
  const started = await startDebugAdapter(executable);
  const dapOutput: string[] = [];
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
    dap.onEvent<StoppedEvent>('stopped', (body) => {
      const waiter = stoppedWaiters.shift();
      if (waiter) waiter(body);
      else stoppedQueue.push(body);
    });
  };
  wire(started.dap);

  const initializeArgs = {
    clientID: 'mcp-smoke',
    clientName: 'MCP JavaScript debugger smoke',
    adapterID: 'javascript',
    linesStartAt1: true,
    columnsStartAt1: true,
    pathFormat: 'path',
    supportsVariableType: true,
    supportsVariablePaging: true,
    supportsRunInTerminalRequest: false,
    supportsStartDebuggingRequest: true,
  };
  const sourceBreakpoints = {
    source: { name: 'fixture.js', path: program },
    breakpoints: [{ line: 2 }],
    sourceModified: false,
  };

  const wireStartDebugging = (dap: DapConnection) => {
    dap.onRequest('startDebugging', async (args) => {
      const configuration = args.configuration as Record<string, unknown> | undefined;
      if (!configuration) throw new Error('startDebugging omitted configuration');
      const child = await started.connectSession();
      target = child;
      wire(child);
      wireStartDebugging(child);
      const initialized = child.waitForEvent('initialized', 10_000);
      await child.request('initialize', initializeArgs);
      const request = args.request === 'attach' || configuration.request === 'attach' ? 'attach' : 'launch';
      const launch = child.request(request, configuration, 30_000);
      void launch.catch(() => undefined);
      await initialized;
      await child.request('setBreakpoints', sourceBreakpoints);
      await child.request('configurationDone');
      await launch;
      return {};
    });
  };
  wireStartDebugging(started.dap);

  try {
    const initialized = started.dap.waitForEvent('initialized', 10_000);
    await started.dap.request('initialize', initializeArgs);
    const launch = started.dap.request('launch', debugAdapter.resolveConfiguration({
      request: 'launch',
      projectRoot,
      file: program,
      name: 'MCP JavaScript debugger smoke',
    }), 30_000);
    void launch.catch(() => undefined);
    await initialized;
    const set = await started.dap.request<{ breakpoints: Array<{ verified: boolean; line?: number }> }>(
      'setBreakpoints',
      sourceBreakpoints,
    );
    await started.dap.request('configurationDone');
    await launch;

    const pause = await Promise.race([
      nextStopped(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('no target stopped')), 20_000)),
    ]);
    const stack = await target.request<{ stackFrames: Array<{ id: number; name: string; line: number }> }>('stackTrace', {
      threadId: pause.threadId,
      startFrame: 0,
      levels: 20,
    });
    const top = stack.stackFrames[0];
    if (!top || top.line !== 2) throw new Error(`expected to pause on line 2, got ${top?.line ?? 'no frame'}`);
    const evaluated = await target.request<{ result: string }>('evaluate', {
      expression: 'base + 1',
      frameId: top.id,
      context: 'repl',
    });
    if (evaluated.result !== '42') throw new Error(`expected base + 1 = 42, got ${evaluated.result}`);
    await target.request('continue', { threadId: pause.threadId });
    await started.dap.request('disconnect', {
      restart: false,
      terminateDebuggee: true,
      suspendDebuggee: false,
    }, 5_000).catch(() => undefined);

    console.log(JSON.stringify({
      initialized: true,
      childSession: target !== started.dap,
      breakpointVerified: set.breakpoints[0]?.verified ?? false,
      pausedLine: top.line,
      evaluated: evaluated.result,
      disconnected: true,
    }));
  } catch (error) {
    console.error(JSON.stringify({ dapOutput, diagnostics: started.diagnostics() }));
    throw error;
  } finally {
    await started.dispose();
    await rm(projectRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
