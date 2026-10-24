import { createHash } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { recallMemoryTool } from '@mcp/code-agent/tools/project-memory-tools.js';
import { prepareCoderAttempt } from '@mcp/code-agent/runtime/attempt-preparation.js';
import type { ChatProvider } from '@mcp/provider-sdk/adapter.js';
import { executeNativeCoder } from '../workers/native-coder-execution.js';
import { dispatchNativeAuthority, type NativeAuthorityOperation } from '../workers/native-authority-bridge.js';
import { buildWorkerMemoryShims } from '../workers/memory-shims.js';
import { registerWorkerMemoryHandlers } from '../sse/worker-memory-handlers.js';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';
import { installNativeSessionHistory } from '../native-session-history.js';
import { createBus } from '../coder-bus.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
physicalIt.each(['recall', 'cancel'] as const)('executes explicit memory reads through native policy and worker RPC: %s', async scenario => {
  const f = await supervisorFactFixture('coder');
  const ports = new MessageChannel();
  const main = new MessageBridge({ port: ports.port1 });
  const worker = new MessageBridge({ port: ports.port2 });
  const bus = createBus(new AbortController());
  const closeHistory = installNativeSessionHistory(f.sessions, f.directory);
  const root = join(f.directory, 'project');
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  let receivedSignal: AbortSignal | undefined;
  const offMemory = registerWorkerMemoryHandlers(main, () => ({ projectMemory: {
    save: async () => null,
    recall: async (_id, _name, query, _limit, signal) => {
      expect(query).toBe('workspace conventions');
      receivedSignal = signal; began();
      if (scenario === 'cancel') await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      });
      return [{ id: '1', title: 'Convention', content: 'MEMORY_PROOF: use the project test script.' }];
    },
    list: async () => [{ name: 'Convention', description: 'test script', type: 'convention', importance: 1, created_at: '' }],
  } }));
  main.handle('native.authority', payload => dispatchNativeAuthority({ authority: f.store, context: f.context,
    operation: (payload as { operation: NativeAuthorityOperation }).operation, assertOwner() {} }));
  let execution: Awaited<ReturnType<typeof executeNativeCoder>> | undefined;
  try {
    const registry = new ToolRegistry(); registry.register(recallMemoryTool); registry.seal();
    const systemPrompt = 'Recall project memory and report the result.';
    const preparation = prepareCoderAttempt({ sessionId: f.context.sessionId, agentRunId: f.context.agentRunId,
      runnerRunId: 'native-memory', provider: 'openai', model: 'fixture', agentDefinitionId: 'coder',
      systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'), capabilityProfile: 'full',
      environment: { kind: 'host', cwd: root }, policy: { permissionMode: 'ask', planMode: false, specMode: false } }, registry);
    let calls = 0;
    const provider: ChatProvider = { name: 'fixture', model: 'fixture', setModel() {}, async *chat(request) {
      calls++;
      if (calls === 1) {
        yield { type: 'tool_call_start', id: 'recall', name: 'recall_memory' };
        yield { type: 'tool_call_end', id: 'recall', name: 'recall_memory', input: { query: 'workspace conventions' } };
        if (scenario === 'recall') {
          yield { type: 'tool_call_start', id: 'index', name: 'recall_memory' };
          yield { type: 'tool_call_end', id: 'index', name: 'recall_memory', input: { mode: 'list' } };
        }
      } else {
        expect(calls).toBe(2);
        expect(request.messages.filter(message => message.role === 'tool')).toHaveLength(2);
        expect(JSON.stringify(request.messages)).toContain('MEMORY_PROOF');
        expect(JSON.stringify((await closeHistory.readLive(f.context.sessionId))?.messages)).toContain('MEMORY_PROOF');
        yield { type: 'text_delta', text: 'Memory loaded.' };
      }
      yield { type: 'done' };
    } };
    const memory = buildWorkerMemoryShims(worker).projectMemory;
    execution = await executeNativeCoder({ bridge: worker, runId: 1, bus, assertOwner() {},
      config: { mode: 'test', context: f.context, packageDirectory: resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
        anchorPath: resolve('dist/apps/electron/native-agent-runtime-integrity.json'), sessionRoot: join(f.directory, 'native-sessions'),
        workspaceRoot: root, workspaceLeaseRoot: join(f.directory, 'native-workspace-leases') },
      prepared: { preparation, registry, provider, systemPrompt, thinking: false, maxTurns: 3,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Recall the workspace conventions.' }] }],
        toolContext: { cwd: root, projectName: 'native-memory', signal: bus.ctrl.signal, projectMemory: {
          save: async () => null,
          recall: (query, limit, signal) => memory.recall(1, 'native-memory', query, limit, signal),
          list: (limit, type, signal) => memory.list(1, 'native-memory', limit, type, signal),
        } } } });
    if (scenario === 'cancel') {
      await started;
      await execution.cancel({ code: 'user_cancelled' });
      expect(await execution.done).toMatchObject({ reason: 'aborted' });
      expect(receivedSignal?.aborted).toBe(true);
      expect(calls).toBe(1);
    } else {
      await execution.done;
      expect(calls).toBe(2);
    }
  } finally {
    bus.ctrl.abort(); offMemory();
    await execution?.done.catch(() => undefined);
    await closeHistory(); main.dispose(); worker.dispose(); ports.port1.close(); ports.port2.close();
    await f.sessions.close(); await rm(f.directory, { recursive: true, force: true });
  }
}, 40_000);
