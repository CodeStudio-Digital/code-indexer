import { createHash, randomUUID } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import { interactionTools } from '@mcp/code-agent/tools/interaction.js';
import { buildSpawnAgentTool } from '@mcp/code-agent/tools/spawn-agent.js';
import { buildCollectAgentsTool } from '@mcp/code-agent/tools/collect-agents.js';
import { sendMessage } from '@mcp/code-agent/tools/send-message.js';
import { sendInput } from '@mcp/code-agent/tools/send-input.js';
import { followupTask } from '@mcp/code-agent/tools/followup-task.js';
import { prepareCoderAttempt } from '@mcp/code-agent/runtime/attempt-preparation.js';
import { rememberNativeProviderSelection } from '@mcp/code-agent/runtime/native-provider-binding.js';
import type { ChatProvider } from '@mcp/provider-sdk/adapter.js';
import { resolveRuntimePolicyV1 } from '../../../packages/agent-runtime-host/src/runtime-policy/RuntimePolicyResolver.js';
import { executeNativeCoder } from '../workers/native-coder-execution.js';
import type { NativeCoderTreeOwner } from '../workers/native-coder-tree.js';
import { dispatchNativeAuthority, type NativeAuthorityOperation } from '../workers/native-authority-bridge.js';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';
import { createBus } from '../coder-bus.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function waitFor(promise: Promise<void>, signal?: AbortSignal) {
  signal?.throwIfAborted(); let abort!: () => void;
  try { await Promise.race([promise, new Promise<never>((_, reject) => {
    abort = () => reject(signal?.reason); signal?.addEventListener('abort', abort, { once: true });
  })]); } finally { signal?.removeEventListener('abort', abort); }
}

physicalIt('runs background collection, messages, question interruption and terminal-child follow-up in a physical Rust tree', async () => {
  const f = await supervisorFactFixture('coder', 120_000);
  const channels = new MessageChannel(), main = new MessageBridge({ port: channels.port1 }), worker = new MessageBridge({ port: channels.port2 });
  const bus = createBus(new AbortController()), question = latch();
  bus.subscribers.add(event => { if (event.event === 'question') question.resolve(); });
  main.handle('native.authority', payload => {
    const packet = payload as { agentRunId: string; operation: NativeAuthorityOperation };
    return dispatchNativeAuthority({ authority: f.store, context: f.context, ...packet, assertOwner() {} });
  });
  const root = join(f.directory, 'project'), leaseRoot = join(f.directory, 'leases');
  let owner!: NativeCoderTreeOwner, execution: Awaited<ReturnType<typeof executeNativeCoder>> | undefined;
  let rootCalls = 0, childCalls = 0, initialJob = '', followupJob = '', target = '';
  let mailboxObserved = false, resumedObserved = false;
  const result = (name: string) => (bus.buffer.filter(event => event.event === 'tool_call_result'
    && (event.data as { name?: string }).name === name).at(-1)?.data as { result: { isError?: boolean; structuredData?: Record<string, unknown> } })?.result;
  const rootProvider: ChatProvider = { name: 'openai', model: 'fixture', setModel() {}, async *chat(request) {
    rootCalls++;
    let name = '', input: Record<string, unknown> = {};
    if (rootCalls === 1) { name = 'spawn_agent'; input = { background: true, agents: [{ task: 'Ask which file to read, then report.', profile: 'full', max_turns: 4 }] }; }
    if (rootCalls === 2) {
      initialJob = String(result('spawn_agent')?.structuredData?.jobId ?? ''); expect(initialJob).toMatch(/^native-job-/);
      await waitFor(question.promise, request.signal);
      const member = owner.list({}).find(member => !member.is_self)!; target = member.path;
      // Crash-boundary fixture: accepted in the durable target inbox, but
      // deliberately absent from the old worker's uncommitted frontier.
      const child = await f.store.resolveNativeChild(f.context, member.agent_run_id);
      await f.store.commitRuntimeRequest(child, `native-tree:inbox:${'c'.repeat(64)}`, { schema: 1, type: 'inbox',
        sourceAgentRunId: f.context.agentRunId, envelope: { id: 'c'.repeat(64), from: '/root', to: target,
          kind: 'message', message: 'Recovered inbox: keep seed.txt unchanged.' } });
      name = 'send_message'; input = { to: target, message: 'The file is seed.txt; preserve it.' };
    }
    if (rootCalls === 3) { expect(result('send_message')?.isError).not.toBe(true); name = 'send_input'; input = { to: target, message: 'No answer needed. Read seed.txt and summarize.' }; }
    if (rootCalls === 4) { expect(result('send_input')?.structuredData?.interrupted).toBe(true); name = 'read_file'; input = { path: 'seed.txt' }; }
    if (rootCalls === 5) { expect(result('read_file')?.isError).not.toBe(true); name = 'collect_agents'; input = { job_id: initialJob, timeout_s: 30 }; }
    if (rootCalls === 6) { expect(result('collect_agents')?.isError).not.toBe(true); name = 'followup_task'; input = { to: target, task: 'Continue the same transcript: give the preserved file name without editing it.' }; }
    if (rootCalls === 7) { followupJob = String(result('followup_task')?.structuredData?.jobId ?? ''); expect(followupJob).toMatch(/^native-job-/); name = 'collect_agents'; input = { job_id: followupJob, timeout_s: 30 }; }
    if (rootCalls === 8) { expect(result('collect_agents')?.isError).not.toBe(true); yield { type: 'text_delta', text: 'Tree complete' }; }
    if (name) { yield { type: 'tool_call_start', id: `root-${rootCalls}`, name }; yield { type: 'tool_call_end', id: `root-${rootCalls}`, name, input }; }
    yield { type: 'done' };
  } };
  const childProvider: ChatProvider = { name: 'openai', model: 'fixture', setModel() {}, async *chat(request) {
    childCalls++;
    if (childCalls === 1) {
      yield { type: 'tool_call_start', id: 'child-question', name: 'ask_user' };
      yield { type: 'tool_call_end', id: 'child-question', name: 'ask_user', input: { question: 'Which file should I inspect?' } };
    } else if (childCalls === 2) {
      const messages = JSON.stringify(request.messages);
      expect(messages).toContain('The file is seed.txt; preserve it.'); expect(messages).toContain('No answer needed.');
      expect(messages).not.toContain('Recovered inbox:');
      expect(messages).toContain('interrupted'); mailboxObserved = true;
      yield { type: 'tool_call_start', id: 'child-read', name: 'read_file' };
      yield { type: 'tool_call_end', id: 'child-read', name: 'read_file', input: { path: 'seed.txt' } };
    } else if (childCalls === 3) yield { type: 'text_delta', text: 'Read seed.txt: preserved content.' };
    else {
      const messages = JSON.stringify(request.messages);
      expect(messages).toContain('Continue the same transcript'); expect(messages).toContain('preserved content');
      expect(messages).toContain('Recovered inbox: keep seed.txt unchanged.');
      resumedObserved = true; yield { type: 'text_delta', text: 'The preserved file is seed.txt.' };
    }
    yield { type: 'done' };
  } };
  try {
    await writeFile(join(root, 'seed.txt'), 'preserved content');
    rememberNativeProviderSelection(childProvider, { provider: 'openai', model: 'fixture' });
    const registry = new ToolRegistry();
    registry.register(fsTools.find(tool => tool.name === 'read_file')!);
    registry.register(interactionTools.find(tool => tool.name === 'ask_user')!);
    registry.registerAll([sendMessage, sendInput, followupTask]);
    const deps = { provider: rootProvider, subagentProvider: childProvider, parentTools: registry.list(), sessionStore: f.sessions };
    registry.register(buildCollectAgentsTool(deps)); registry.register(buildSpawnAgentTool(deps, registry)); registry.seal();
    const systemPrompt = 'Execute the owned task and retain all human permission gates.';
    const runtime = resolveRuntimePolicyV1({ request: { revision: 'messaging-fixture', values: {
      execution: { maxTurns: 20, maxToolCalls: 20, maxWallMs: 90_000 }, subagents: { maxParallel: 2, maxDepth: 2 } } } });
    execution = await executeNativeCoder({ bridge: worker, runId: 1, bus, assertOwner() {},
      tree: { maxAgents: 5, maxDepth: 2, maxParallel: 2, ready(value) { owner = value; } },
      config: { mode: 'test', context: f.context, packageDirectory: resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
        anchorPath: resolve('dist/apps/electron/native-agent-runtime-integrity.json'), sessionRoot: join(f.directory, 'native-sessions'),
        workspaceRoot: root, workspaceLeaseRoot: leaseRoot },
      prepared: { registry, systemPrompt, provider: rootProvider, thinking: false, maxTurns: 20,
        preparation: prepareCoderAttempt({ sessionId: f.context.sessionId, agentRunId: f.context.agentRunId, runnerRunId: randomUUID(),
          provider: 'openai', model: 'fixture', agentDefinitionId: 'coder', systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'),
          capabilityProfile: 'full', environment: { kind: 'host', cwd: root }, policy: { permissionMode: 'auto', planMode: false, specMode: false, runtime } }, registry),
        toolContext: { cwd: root, projectName: 'native-messaging', sessionId: f.context.sessionId, runtimeGeneration: 'rust_v1', controlPlaneParentAgentRunId: f.context.agentRunId },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Coordinate the native agents.' }] }] } });
    expect((await execution.done).reason).toBe('completed');
    expect({ rootCalls, childCalls, mailboxObserved, resumedObserved }).toEqual({ rootCalls: 8, childCalls: 4, mailboxObserved: true, resumedObserved: true });
    expect(await readFile(join(root, 'seed.txt'), 'utf8')).toBe('preserved content');
    expect(JSON.parse(await readFile(join(leaseRoot, 'leases.json'), 'utf8')).state.leases).toEqual([]);
    const rows = (await f.repository.list('runtimeRequest')).items;
    expect(rows.filter(row => (row.data.nativeTree as { type?: string })?.type === 'message')).toHaveLength(2);
    expect(rows.filter(row => (row.data.nativeTree as { type?: string })?.type === 'inbox')).toHaveLength(6);
    expect(rows.filter(row => (row.data.nativeTree as { type?: string })?.type === 'result')).toHaveLength(2);
    if (process.env.MCP_NATIVE_MESSAGING_REPORT) {
      const report = resolve(process.env.MCP_NATIVE_MESSAGING_REPORT);
      if (!report.toLowerCase().startsWith(resolve('scratch').toLowerCase() + '\\')) throw new Error('Unsafe report path');
      await writeFile(report, JSON.stringify({ passed: true, rootCalls, childCalls, mailboxObserved, resumedObserved,
        rootAndChildren: (await f.repository.list('nativeActivation')).items.length, pendingLeases: 0, deterministicProvider: true }, null, 2));
    }
  } catch (cause) {
    const report = process.env.MCP_NATIVE_MESSAGING_REPORT;
    if (report && resolve(report).toLowerCase().startsWith(resolve('scratch').toLowerCase() + '\\')) {
      await writeFile(report, JSON.stringify({ passed: false, error: cause instanceof Error ? cause.stack : String(cause), rootCalls, childCalls,
        events: bus.buffer.filter(event => ['error', 'run_error', 'tool_call_result', 'question', 'agent_progress', 'agents_group_end'].includes(event.event)).slice(-25),
        runs: (await f.repository.list('run')).items.map(row => row.data.run) }, null, 2));
    }
    throw cause;
  } finally {
    question.resolve(); bus.ctrl.abort();
    if (execution) { await execution.cancel({ code: 'user_cancelled' }).catch(() => undefined); await execution.done.catch(() => undefined); }
    main.dispose(); worker.dispose(); channels.port1.close(); channels.port2.close(); await f.sessions.close();
    if (!resolve(f.directory).toLowerCase().startsWith(resolve(tmpdir(), 'codestudio-supervisor-facts-').toLowerCase())) throw new Error('Unsafe fixture cleanup');
    await rm(f.directory, { recursive: true, force: true });
    if (owner) expect(owner.shared.resources.snapshot()).toEqual({ memoryBytes: 0, processes: 0, groups: 0 });
  }
}, 100_000);
