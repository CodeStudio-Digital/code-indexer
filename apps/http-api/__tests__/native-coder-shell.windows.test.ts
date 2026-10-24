import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { expect, it, vi } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { approvalAskId } from '@mcp/code-agent/core/permission-gate.js';
import { shellTools } from '@mcp/code-agent/tools/shell.js';
import { gitTools } from '@mcp/code-agent/tools/git.js';
import { prepareCoderAttempt } from '@mcp/code-agent/runtime/attempt-preparation.js';
import type { PreparedCoderExecution } from '@mcp/code-agent/runtime/prepared-coder-execution.js';
import type { ChatProvider } from '@mcp/provider-sdk/adapter.js';
import { executeNativeCoder } from '../workers/native-coder-execution.js';
import { dispatchNativeAuthority, type NativeAuthorityOperation } from '../workers/native-authority-bridge.js';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';
import { createBus } from '../coder-bus.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
physicalIt.each(['approve', 'cancel', 'deny'] as const)('owns real Host commands and Git through native policy: %s', async decision => {
  const product = await supervisorFactFixture('coder');
  const ports = new MessageChannel();
  const main = new MessageBridge({ port: ports.port1 });
  const worker = new MessageBridge({ port: ports.port2 });
  const bus = createBus(new AbortController());
  const root = join(product.directory, 'project');
  let execution!: PreparedCoderExecution;
  let publishHandle!: () => void;
  const ready = new Promise<void>(resolve => { publishHandle = resolve; });
  const approvals: Promise<void>[] = [];
  main.handle('native.authority', payload => dispatchNativeAuthority({ authority: product.store, context: product.context,
    operation: (payload as { operation: NativeAuthorityOperation }).operation, assertOwner() {} }));
  bus.subscribers.add(event => {
    if (event.event !== 'tool_approval_request') return;
    const request = event.data as { toolUseId: string; toolName: string };
    const response = (async () => {
      await ready;
      expect(request.toolName).toBe('run_command');
      expect(existsSync(join(root, 'command.txt'))).toBe(false);
      await execution.provideInput(approvalAskId(request.toolUseId), JSON.stringify({ approved: decision !== 'deny' }));
    })();
    void response.catch(error => bus.ctrl.abort(error));
    approvals.push(response);
  });
  try {
    const registry = new ToolRegistry();
    registry.register(shellTools.find(tool => tool.name === 'run_command')!);
    registry.register(gitTools.find(tool => tool.name === 'git_status')!);
    registry.seal();
    const systemPrompt = 'Run the approved command and inspect Git.';
    const preparation = prepareCoderAttempt({ sessionId: product.context.sessionId, agentRunId: product.context.agentRunId,
      runnerRunId: 'native-shell', provider: 'openai', model: 'fixture', agentDefinitionId: 'coder', capabilityProfile: 'full',
      systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'), environment: { kind: 'host', cwd: root },
      policy: { permissionMode: 'ask', planMode: false, specMode: false } }, registry);
    let calls = 0;
    const provider: ChatProvider = { name: 'openai', model: 'fixture', setModel() {}, async *chat(request) {
      if (++calls === 1) {
        const script = decision === 'cancel'
          ? 'const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true});require("node:fs").writeFileSync("command.txt",String(c.pid));setInterval(()=>{},1000);'
          : 'require("node:child_process").execFileSync("git",["init","--quiet"]);require("node:fs").writeFileSync("command.txt","owned-command");console.log("command complete");';
        const tools = [{ id: 'shell', name: 'run_command', input: { command: 'node -', stdin: script } },
          { id: 'git', name: 'git_status', input: {} }];
        for (const tool of tools) {
          yield { type: 'tool_call_start', id: tool.id, name: tool.name };
          yield { type: 'tool_call_end', ...tool };
        }
      } else {
        if (decision === 'approve') {
          expect(await readFile(join(root, 'command.txt'), 'utf8')).toBe('owned-command');
          expect(JSON.stringify(request.messages)).toContain('?? command.txt');
          expect(JSON.stringify(request.messages)).toContain('command complete');
        } else expect(existsSync(join(root, 'command.txt'))).toBe(false);
        yield { type: 'text_delta', text: 'commands complete' };
      }
      yield { type: 'done' };
    } };
    execution = await executeNativeCoder({ bridge: worker, runId: 1, bus, assertOwner() {},
      config: { mode: 'test', context: product.context, packageDirectory: resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
        anchorPath: resolve('dist/apps/electron/native-agent-runtime-integrity.json'), sessionRoot: join(product.directory, 'native-sessions'),
        workspaceRoot: root, workspaceLeaseRoot: join(product.directory, 'native-workspace-leases') },
      prepared: { preparation, registry, provider, systemPrompt, thinking: false, maxTurns: 3,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Run commands' }] }],
        toolContext: { cwd: root, projectName: 'native-shell', signal: bus.ctrl.signal }, signal: bus.ctrl.signal } });
    publishHandle();
    let childPid: number | undefined;
    if (decision === 'cancel') {
      await vi.waitFor(() => expect(existsSync(join(root, 'command.txt'))).toBe(true), { timeout: 10_000 });
      childPid = Number(await readFile(join(root, 'command.txt'), 'utf8'));
      process.kill(childPid, 0);
      await execution.cancel({ code: 'user_cancelled' });
    }
    try { await execution.done; }
    catch (cause) { throw new Error(`Native command failed: ${JSON.stringify(bus.buffer.filter(event => event.event === 'tool_call_result'))}`, { cause }); }
    await Promise.all(approvals);
    expect(approvals).toHaveLength(1);
    expect(calls).toBe(decision === 'cancel' ? 1 : 2);
    if (childPid) expect(() => process.kill(childPid, 0)).toThrow();
    expect(JSON.parse(await readFile(join(product.directory, 'native-workspace-leases', 'leases.json'), 'utf8')).state.leases).toEqual([]);
  } finally {
    bus.ctrl.abort(); main.dispose(); worker.dispose(); ports.port1.close(); ports.port2.close();
    await product.sessions.close(); await rm(product.directory, { recursive: true, force: true });
  }
}, 40_000);
