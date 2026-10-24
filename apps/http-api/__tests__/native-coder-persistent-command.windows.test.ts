import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { expect, it, vi } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { execCommandTools } from '@mcp/code-agent/tools/exec-command.js';
import { approvalAskId } from '@mcp/code-agent/core/permission-gate.js';
import { prepareCoderAttempt } from '@mcp/code-agent/runtime/attempt-preparation.js';
import type { ChatProvider } from '@mcp/provider-sdk/adapter.js';
import type { PreparedCoderExecution } from '@mcp/code-agent/runtime/prepared-coder-execution.js';
import { executeNativeCoder } from '../workers/native-coder-execution.js';
import { dispatchNativeAuthority, type NativeAuthorityOperation } from '../workers/native-authority-bridge.js';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';
import { createBus } from '../coder-bus.js';
import { NativeSessionReader, parseRuntimePackageAnchor, verifyRuntimePackage } from '@mcp/agent-runtime-host';
import { inspectNativeContinuation } from '../workers/native-coder-continuation.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
physicalIt.each(['complete', 'cancel'] as const)('keeps an owned command across native provider turns: %s', async mode => {
  const product = await supervisorFactFixture('coder'); const root = join(product.directory, 'project');
  const channels = new MessageChannel(); const main = new MessageBridge({ port: channels.port1 });
  const worker = new MessageBridge({ port: channels.port2 }); const bus = createBus(new AbortController());
  main.handle('native.authority', payload => dispatchNativeAuthority({ authority: product.store, context: product.context,
    operation: (payload as { operation: NativeAuthorityOperation }).operation, assertOwner() {} }));
  await writeFile(join(root, 'persistent.cjs'), `
    const child = require('child_process').spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], {detached:true,stdio:'ignore',windowsHide:true});
    require('fs').writeFileSync('processes.json', JSON.stringify([process.pid,child.pid]));
    console.error('NATIVE_PROMPT');
    require('readline').createInterface({input:process.stdin}).on('line', line => {
      console.log('ACK:' + line); if(line==='exit') process.exit(0);
    });
  `);
  let execution: PreparedCoderExecution | undefined; let calls = 0; let polls = 0; let phase = 0;
  let sessionId = ''; let readyToCancel = false;
  let publishHandle!: () => void;
  const handleReady = new Promise<void>(resolve => { publishHandle = resolve; });
  const approvals: Promise<void>[] = [];
  let resolveRecall!: (rows: { id: string; title: string; content: string }[]) => void;
  const recall = vi.fn(() => new Promise<{ id: string; title: string; content: string }[]>(resolve => { resolveRecall = resolve; }));
  bus.subscribers.add(event => {
    if (event.event !== 'tool_approval_request') return;
    const request = event.data as { toolUseId: string; toolName: string };
    const response = (async () => { await handleReady;
      expect(['exec_command', 'write_stdin']).toContain(request.toolName);
      await execution!.provideInput(approvalAskId(request.toolUseId), JSON.stringify({ approved: true }));
    })();
    void response.catch(cause => bus.ctrl.abort(cause)); approvals.push(response);
  });
  const provider: ChatProvider = { name: 'openai', model: 'fixture', setModel() {}, async *chat(request) {
    calls++;
    let name: string; let input: Record<string, unknown>;
    const transcript = JSON.stringify(request.messages);
    if (phase === 0) {
      expect(transcript).not.toContain('LATE_MEMORY_PROOF');
      resolveRecall([{ id: 'memory', title: 'Convention', content: 'LATE_MEMORY_PROOF' }]);
      phase = 1; name = 'exec_command'; input = { cmd: `"${process.execPath}" persistent.cjs`, yield_time_ms: 1000 };
    }
    else if (phase === 1) {
      expect(transcript).toContain('LATE_MEMORY_PROOF');
      sessionId = /session_id=(\w+)/.exec(transcript)![1];
      expect(transcript).toContain('status=running'); name = 'write_stdin';
      if (!transcript.includes('NATIVE_PROMPT')) {
        expect(++polls).toBeLessThanOrEqual(8);
        input = { session_id: sessionId, chars: '', yield_time_ms: 500 };
      } else { phase = 2; input = { session_id: sessionId, chars: 'hello\n', yield_time_ms: 500 }; }
    } else if (phase === 2) {
      expect(transcript).toContain('ACK:hello');
      if (mode === 'cancel') {
        readyToCancel = true;
        await new Promise<void>(resolve => { if (bus.ctrl.signal.aborted) resolve(); else bus.ctrl.signal.addEventListener('abort', () => resolve(), { once: true }); });
        yield { type: 'done' }; return;
      }
      phase = 3; name = 'write_stdin'; input = { session_id: sessionId, chars: 'exit\n', yield_time_ms: 2000 };
    } else {
      expect(transcript).toContain('status=exited exit=0'); expect(transcript).toContain('ACK:exit');
      yield { type: 'text_delta', text: 'PERSISTENT_COMPLETE' }; yield { type: 'done' }; return;
    }
    yield { type: 'tool_call_start', id: `persistent-${calls}`, name };
    yield { type: 'tool_call_end', id: `persistent-${calls}`, name, input }; yield { type: 'done' };
  } };
  try {
    const registry = new ToolRegistry(); for (const tool of execCommandTools) registry.register(tool); registry.seal();
    const systemPrompt = 'Exercise the persistent command.';
    const preparation = prepareCoderAttempt({ sessionId: product.context.sessionId, agentRunId: product.context.agentRunId,
      runnerRunId: 'native-persistent', provider: 'openai', model: 'fixture', agentDefinitionId: 'coder', capabilityProfile: 'full',
      systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'), environment: { kind: 'host', cwd: root },
      policy: { permissionMode: 'ask', planMode: false, specMode: false } }, registry);
    execution = await executeNativeCoder({ bridge: worker, runId: 1, bus, assertOwner() {},
      config: { mode: 'test', context: product.context, packageDirectory: resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
        anchorPath: resolve('dist/apps/electron/native-agent-runtime-integrity.json'), sessionRoot: join(product.directory, 'native-sessions'),
        workspaceRoot: root, workspaceLeaseRoot: join(product.directory, 'native-workspace-leases') },
      prepared: { preparation, registry, provider, systemPrompt, thinking: false, maxTurns: 13,
        boundaryRecall: { memory: recall },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Start then interact then exit' }] }],
        toolContext: { cwd: root, projectName: 'native-persistent', signal: bus.ctrl.signal }, signal: bus.ctrl.signal } });
    publishHandle();
    if (mode === 'cancel') {
      await vi.waitFor(() => expect(readyToCancel).toBe(true), { timeout: 15_000 });
      await execution.cancel({ code: 'user_cancelled' });
    }
    await execution.done;
    await Promise.all(approvals);
    expect(approvals).toHaveLength((mode === 'cancel' ? 2 : 3) + polls);
    expect(calls).toBe((mode === 'cancel' ? 3 : 4) + polls);
    expect(recall).toHaveBeenCalledOnce();
    const pids = JSON.parse(await readFile(join(root, 'processes.json'), 'utf8')) as number[];
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    expect(JSON.parse(await readFile(join(product.directory, 'native-workspace-leases', 'leases.json'), 'utf8')).state.leases).toEqual([]);
    if (mode === 'cancel') {
      const runtime = await verifyRuntimePackage(resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
        parseRuntimePackageAnchor(await readFile('dist/apps/electron/native-agent-runtime-integrity.json')));
      const reader = await NativeSessionReader.open(runtime, { rootPath: join(product.directory, 'native-sessions'), sessionId: product.context.sessionId });
      try {
        expect((await inspectNativeContinuation(reader, true))?.preparedBoundaryContext?.contentUtf8).toContain('LATE_MEMORY_PROOF');
      } finally { await reader.close(); }
    }
  } finally {
    bus.ctrl.abort(); await execution?.done.catch(() => undefined);
    main.dispose(); worker.dispose(); channels.port1.close(); channels.port2.close();
    await product.sessions.close(); await rm(product.directory, { recursive: true, force: true });
  }
}, 40_000);
