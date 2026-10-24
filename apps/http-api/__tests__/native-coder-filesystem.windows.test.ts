import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { approvalAskId } from '@mcp/code-agent/core/permission-gate.js';
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import { applyPatchTool } from '@mcp/code-agent/tools/apply-patch.js';
import { prepareCoderAttempt } from '@mcp/code-agent/runtime/attempt-preparation.js';
import type { PreparedCoderExecution } from '@mcp/code-agent/runtime/prepared-coder-execution.js';
import type { ChatProvider } from '@mcp/provider-sdk/adapter.js';
import { executeNativeCoder } from '../workers/native-coder-execution.js';
import { dispatchNativeAuthority, type NativeAuthorityOperation } from '../workers/native-authority-bridge.js';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';
import { createBus } from '../coder-bus.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
physicalIt.each(['approve', 'deny', 'cancel', 'abort', 'preparation-failure'] as const)('fences real create/patch/read through product native composition, decision=%s', async decision => {
  const approved = decision === 'approve';
  const cancelled = decision === 'cancel' || decision === 'abort';
  const product = await supervisorFactFixture('coder');
  const ports = new MessageChannel();
  const main = new MessageBridge({ port: ports.port1 });
  const worker = new MessageBridge({ port: ports.port2 });
  const bus = createBus(new AbortController());
  const root = join(product.directory, 'project');
  let execution!: PreparedCoderExecution;
  let publishHandle!: () => void;
  const handleReady = new Promise<void>(resolve => { publishHandle = resolve; });
  const approvals: Promise<void>[] = [];
  const approvedNames: string[] = [];
  main.handle('native.authority', payload => dispatchNativeAuthority({ authority: product.store, context: product.context,
    operation: (payload as { operation: NativeAuthorityOperation }).operation, assertOwner() {} }));
  bus.subscribers.add(event => {
    if (event.event !== 'tool_approval_request') return;
    const request = event.data as { toolUseId: string; toolName: string };
    approvedNames.push(request.toolName);
    const response = (async () => {
      await handleReady;
      if (request.toolName === 'create_file' || !approved) expect(existsSync(join(root, 'created.txt'))).toBe(false);
      if (cancelled) {
        if (decision === 'abort') bus.ctrl.abort({ code: 'user_cancelled' });
        else await execution.cancel({ code: 'user_cancelled' });
        return;
      }
      await execution.provideInput(approvalAskId(request.toolUseId), JSON.stringify({ approved }));
    })();
    void response.catch(cause => bus.ctrl.abort(cause));
    approvals.push(response);
  });
  try {
    const registry = new ToolRegistry();
    for (const tool of [...fsTools.filter(tool => ['create_file', 'read_file'].includes(tool.name)), applyPatchTool]) registry.register(tool);
    registry.seal();
    const systemPrompt = 'Create a file, patch it, then read it in that order.';
    const preparation = prepareCoderAttempt({ sessionId: product.context.sessionId, agentRunId: product.context.agentRunId,
      runnerRunId: 'native-fs', provider: 'openai', model: 'fixture', agentDefinitionId: 'coder', capabilityProfile: 'full',
      systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'), environment: { kind: 'host', cwd: root },
      policy: { permissionMode: 'ask', planMode: false, specMode: false } }, registry);
    let calls = 0;
    const provider: ChatProvider = { name: 'openai', model: 'fixture', setModel() {}, async *chat(request) {
      if (++calls === 1) {
        const tools = [
          { id: 'create', name: 'create_file', input: { path: 'created.txt', content: 'before\n' } },
          { id: 'patch', name: 'apply_patch', input: { patch: '*** Begin Patch\n*** Update File: created.txt\n@@\n-before\n+after\n*** End Patch' } },
          { id: 'read', name: 'read_file', input: { path: 'created.txt' } },
        ];
        for (const tool of tools) {
          yield { type: 'tool_call_start', id: tool.id, name: tool.name };
          yield { type: 'tool_call_end', ...tool };
        }
      } else {
        if (approved) {
          expect(await readFile(join(root, 'created.txt'), 'utf8')).toBe('after\n');
          expect(JSON.stringify(request.messages)).toContain('after');
        } else expect(existsSync(join(root, 'created.txt'))).toBe(false);
        yield { type: 'text_delta', text: 'filesystem complete' };
      }
      yield { type: 'done' };
    } };
    const starting = executeNativeCoder({ bridge: worker, runId: 1, bus, assertOwner() {},
      config: { mode: 'test', context: product.context, packageDirectory: resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
        anchorPath: resolve('dist/apps/electron/native-agent-runtime-integrity.json'), sessionRoot: join(product.directory, 'native-sessions'),
        workspaceRoot: root, workspaceLeaseRoot: join(product.directory, 'native-workspace-leases') },
      prepared: { preparation, registry, provider, systemPrompt, thinking: false, maxTurns: 3,
        messages: [{ role: 'user', content: decision === 'preparation-failure'
          ? [{ type: 'text', text: 'invalid attachment' }, { type: 'image', mediaType: 'image/png', base64: 'invalid%%' }]
          : [{ type: 'text', text: 'Create, patch, read' }] }],
        toolContext: { cwd: root, projectName: 'native-fs', signal: bus.ctrl.signal }, signal: bus.ctrl.signal } });
    if (decision === 'preparation-failure') {
      await expect(starting).rejects.toThrow('encoding is invalid');
      expect(calls).toBe(0);
      const leases = JSON.parse(await readFile(join(product.directory, 'native-workspace-leases', 'leases.json'), 'utf8'));
      expect(leases.state.leases).toEqual([]);
      return;
    }
    execution = await starting;
    publishHandle();
    try { await execution.done; }
    catch (cause) { throw new Error(`Native filesystem failed: ${JSON.stringify(bus.buffer.filter(event => event.event === 'tool_call_result'))}`, { cause }); }
    await Promise.all(approvals);
    expect(approvedNames).toEqual(cancelled ? ['create_file'] : ['create_file', 'apply_patch']);
    expect(calls).toBe(cancelled ? 1 : 2);
    if (cancelled) expect(existsSync(join(root, 'created.txt'))).toBe(false);
    const leases = JSON.parse(await readFile(join(product.directory, 'native-workspace-leases', 'leases.json'), 'utf8'));
    expect(leases.state.leases).toEqual([]);
  } finally {
    bus.ctrl.abort(); main.dispose(); worker.dispose(); ports.port1.close(); ports.port2.close();
    await product.sessions.close(); await rm(product.directory, { recursive: true, force: true });
  }
}, 40_000);
