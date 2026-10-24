import { createHash, randomUUID } from 'node:crypto';
import { create, toBinary } from '@bufbuild/protobuf';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { MessageChannel } from 'node:worker_threads';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import { applyPatchTool } from '@mcp/code-agent/tools/apply-patch.js';
import { prepareCoderAttempt } from '@mcp/code-agent/runtime/attempt-preparation.js';
import type { PreparedCoderInputs } from '@mcp/code-agent/runtime/prepared-coder-execution.js';
import type { ChatProvider } from '@mcp/provider-sdk/adapter.js';
import type { ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import { resolveRuntimePolicyV1 } from '../../../packages/agent-runtime-host/src/runtime-policy/RuntimePolicyResolver.js';
import { parseRuntimePackageAnchor, verifyRuntimePackage } from '@mcp/agent-runtime-host';
import { executeNativeCoder } from '../workers/native-coder-execution.js';
import { nativeChildSessionRoot, type NativeCoderTreeOwner } from '../workers/native-coder-tree.js';
import { dispatchNativeAuthority, type NativeAuthorityOperation } from '../workers/native-authority-bridge.js';
import { NativeWorkspaceLeaseStore } from '../native-workspace-leases.js';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';
import { createBus } from '../coder-bus.js';
import { runSubagent, runParallelAgents } from '@mcp/code-agent/tools/implement-subagent.js';
import { rememberNativeProviderSelection } from '@mcp/code-agent/runtime/native-provider-binding.js';
import { buildSpawnAgentTool } from '@mcp/code-agent/tools/spawn-agent.js';
import { buildResumeAgentTool } from '@mcp/code-agent/tools/resume-agent.js';
import { buildRequestReviewTool } from '@mcp/code-agent/tools/request-review.js';
import { buildReadAgentTranscriptTool, findRetainedAgent } from '@mcp/code-agent/tools/read-agent-transcript.js';
import { createNativeChildHistoryReader } from '../workers/native-child-history-reader.js';
import { registerWorkerNativeChildHistory } from '../sse/worker-native-child-history.js';
import { buildWorkflowTool } from '@mcp/code-agent/tools/workflow/workflow-tool.js';
import { clearWorkflows, getWorkflow, saveWorkflow } from '@mcp/code-agent/tools/workflow/workflow-registry.js';
import { listAgents } from '@mcp/code-agent/tools/list-agents.js';
import { waitAgents } from '@mcp/code-agent/tools/wait-agents.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
const reports: unknown[] = [];
function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function waitFor(promise: Promise<void>, signal?: AbortSignal) {
  signal?.throwIfAborted(); let abort!: () => void;
  try { await Promise.race([promise, new Promise<never>((_, reject) => {
    abort = () => reject(signal?.reason); signal?.addEventListener('abort', abort, { once: true });
  })]); } finally { signal?.removeEventListener('abort', abort); }
}

physicalIt.each(['complete', 'cancel', 'preparation_failure', 'approval', 'denial', 'adapter', 'adapter_cancel', 'uncertain_child', 'uncertain_spawn', 'spawn_tool', 'resume_tool', 'adapter_resume', 'parallel_reads', 'parallel_writes', 'request_review', 'memo_tool', 'nested_progress', 'scoped_patch', 'workflow_recovery', 'workflow_tool', 'workflow_uncertain', 'shared_budget', 'inventory', 'parallel_wait'] as const)('owns the complete native coder tree: %s', async scenario => {
  const toolScenario = ['spawn_tool', 'resume_tool', 'memo_tool', 'uncertain_spawn', 'shared_budget', 'inventory'].includes(scenario);
  const parallelScenario = scenario === 'parallel_reads' || scenario === 'parallel_writes' || scenario === 'parallel_wait';
  const f = await supervisorFactFixture('coder', 90_000);
  const channels = new MessageChannel();
  const main = new MessageBridge({ port: channels.port1 }), worker = new MessageBridge({ port: channels.port2 });
  const rootBus = createBus(new AbortController());
  const parentEntered = latch(), parentContinue = latch(), childEntered = latch(), childContinue = latch();
  let approvalId = '';
  rootBus.subscribers.add(event => {
    if (event.event === 'tool_approval_request') approvalId = `tool_approval:${(event.data as { toolUseId: string }).toolUseId}`;
  });
  const root = join(f.directory, 'project'), leaseRoot = join(f.directory, 'leases'), sessionRoot = join(f.directory, 'native-sessions');
  const config = { mode: 'test' as const, context: f.context, packageDirectory: resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
    anchorPath: resolve('dist/apps/electron/native-agent-runtime-integrity.json'), sessionRoot, workspaceRoot: root, workspaceLeaseRoot: leaseRoot };
  let historyOwnerLive = true;
  let historyWorkerCold = false;
  const offHistory = registerWorkerNativeChildHistory(main, (runId, closing) => ({ config: historyWorkerCold ? undefined : config, store: f.store,
    sessionId: f.context.sessionId, projectId: 1, signal: rootBus.ctrl.signal, assertOwner() {
      if (!historyOwnerLive || runId !== (historyWorkerCold ? 0 : 1) || closing !== true) throw new Error('Stale history worker');
    } }));
  main.handle('native.authority', payload => {
    const packet = payload as { agentRunId: string; operation: NativeAuthorityOperation };
    return dispatchNativeAuthority({ authority: f.store, context: f.context, ...packet, assertOwner() {} });
  });
  let owner!: NativeCoderTreeOwner;
  let execution: Awaited<ReturnType<typeof executeNativeCoder>> | undefined;
  let child: ReturnType<NativeCoderTreeOwner['runPrepared']> | undefined;
  let calls = 0;
  const started = performance.now();
  const prepare = (context: ControlPlaneRunContext, provider: ChatProvider, text: string): PreparedCoderInputs => {
    const registry = new ToolRegistry(), createFile = fsTools.find(tool => tool.name === 'create_file')!;
    if (scenario === 'inventory') registry.register(listAgents);
    if (scenario === 'parallel_wait') registry.register(waitAgents);
    registry.register(scenario === 'uncertain_child' || scenario === 'uncertain_spawn' || scenario === 'workflow_uncertain' ? { ...createFile, async handler(args, context) {
      await createFile.handler(args, context);
      return { content: 'lost acknowledgement after the write', isError: true, effectOutcome: 'unknown' as const };
    } } : createFile);
    if ((scenario === 'workflow_tool' || scenario === 'workflow_uncertain') && context.agentRunId === f.context.agentRunId) {
      registry.register(fsTools.find(tool => tool.name === 'read_file')!);
      registry.register(buildWorkflowTool({ provider: parentProvider, subagentProvider: childProvider,
        resolveProviderForProfile: async profile => profile === 'verify' ? verificationProvider : childProvider,
        parentTools: registry.list(), sessionStore: f.sessions }));
    }
    if (scenario === 'scoped_patch') registry.register(applyPatchTool);
    if (parallelScenario || scenario === 'request_review') registry.register(fsTools.find(tool => tool.name === 'read_file')!);
    if (scenario === 'request_review') registry.register(buildRequestReviewTool({ provider: parentProvider,
      resolveReviewerProvider: async () => childProvider, parentTools: registry.list() }));
    if (toolScenario && context.agentRunId === f.context.agentRunId || scenario === 'nested_progress') {
      const retention = scenario === 'resume_tool' ? { sessionId: f.context.sessionId, sessionStore: f.sessions } : {};
      registry.register(buildSpawnAgentTool({ provider: parentProvider, subagentProvider: childProvider, parentTools: registry.list(), ...retention }, registry));
      registry.register(buildResumeAgentTool({ provider: parentProvider, subagentProvider: childProvider, parentTools: registry.list(), ...retention }));
      registry.register(buildReadAgentTranscriptTool());
    }
    registry.seal();
    const systemPrompt = 'Execute only the owned task.';
    const runtime = resolveRuntimePolicyV1({ request: { revision: 'tree-fixture', values: {
      execution: { maxTurns: scenario === 'shared_budget' ? 3 : 8, maxToolCalls: 8, maxWallMs: 60_000 } } } });
    return { registry, systemPrompt, provider, thinking: false, maxTurns: 8,
      preparation: prepareCoderAttempt({ sessionId: context.sessionId, agentRunId: context.agentRunId,
        runnerRunId: randomUUID(), provider: 'openai', model: 'fixture', agentDefinitionId: 'coder',
        systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'), capabilityProfile: 'full',
        environment: { kind: 'host', cwd: root }, policy: { permissionMode: 'auto', planMode: false, specMode: false, runtime } }, registry),
      toolContext: { cwd: root, projectName: 'native-tree', runtimeGeneration: 'rust_v1', controlPlaneParentAgentRunId: context.agentRunId },
      messages: [{ role: 'user', content: [{ type: 'text', text }] }] };
  };
  let rootCalls = 0;
  const parentProvider: ChatProvider = { name: 'openai', model: 'fixture', setModel() {}, async *chat(request) {
    rootCalls++; parentEntered.resolve();
    if ((scenario === 'workflow_tool' || scenario === 'workflow_uncertain') && rootCalls === 1) {
      yield { type: 'tool_call_start', id: 'workflow-owned-child', name: 'workflow' };
      yield { type: 'tool_call_end', id: 'workflow-owned-child', name: 'workflow', input: {
        steps: [{ id: 'write_once', prompt: 'Write child.txt once, then summarize.', profile: 'implement', files: ['child.txt'] },
          { id: 'verify', prompt: 'Read child.txt and verify the prerequisite.', profile: 'verify', depends_on: ['write_once'] }] } };
      yield { type: 'done' }; return;
    }
    if (scenario === 'request_review' && rootCalls === 1) {
      yield { type: 'tool_call_start', id: 'review-owned-child', name: 'request_review' };
      yield { type: 'tool_call_end', id: 'review-owned-child', name: 'request_review', input: { spec: 'Check the seed file', diff: 'diff --git a/seed.txt b/seed.txt\n+shared read content' } };
      yield { type: 'done' }; return;
    }
    if (toolScenario && rootCalls === 1) {
      yield { type: 'tool_call_start', id: 'spawn-real-child', name: 'spawn_agent' };
      yield { type: 'tool_call_end', id: 'spawn-real-child', name: 'spawn_agent', input: {
        agents: [{ task: scenario === 'memo_tool' ? 'Record a warning memo and summarize.' : 'Write child.txt once, then summarize.',
          profile: scenario === 'memo_tool' ? 'explore' : 'implement', max_turns: scenario === 'resume_tool' ? 1 : 3 }] } };
      yield { type: 'done' }; return;
    }
    if (scenario === 'resume_tool' && rootCalls === 2) {
      const group = rootBus.buffer.find(event => event.event === 'agents_group_start')?.data as { groupId: string };
      yield { type: 'tool_call_start', id: 'resume-child', name: 'resume_agent' };
      yield { type: 'tool_call_end', id: 'resume-child', name: 'resume_agent', input: { spawn_id: group.groupId, guidance: 'Summarize the confirmed write without repeating it.' } };
      yield { type: 'done' }; return;
    }
    if (toolScenario && rootCalls === (scenario === 'resume_tool' ? 3 : 2)) {
      if (scenario === 'inventory') {
        yield { type: 'tool_call_start', id: 'list-owned-tree', name: 'list_agents' };
        yield { type: 'tool_call_end', id: 'list-owned-tree', name: 'list_agents', input: { format: 'json' } };
        yield { type: 'done' }; return;
      }
      if (scenario === 'resume_tool') {
        const resumed = rootBus.buffer.filter(event => event.event === 'tool_call_result').at(-1)?.data;
        expect(resumed).toMatchObject({ name: 'resume_agent', result: { isError: false } });
      }
      const group = rootBus.buffer.find(event => event.event === 'agents_group_start')?.data as { groupId: string };
      yield { type: 'tool_call_start', id: 'read-child-history', name: 'read_agent_transcript' };
      yield { type: 'tool_call_end', id: 'read-child-history', name: 'read_agent_transcript', input: { spawn_id: group.groupId, max_chars: 2000 } };
      yield { type: 'done' }; return;
    }
    await waitFor(parentContinue.promise, request.signal);
    yield { type: 'text_delta', text: 'Root complete' }; yield { type: 'done' };
  } };
  const childProvider: ChatProvider = { name: 'openai', model: 'fixture', setModel() {}, async *chat(request) {
    calls++;
    if (calls === 1) {
      if (scenario === 'request_review') {
        expect(JSON.stringify(request.messages)).not.toContain('Wait for the child.');
        expect(request.tools.map(tool => tool.name)).not.toContain('create_file');
        yield { type: 'tool_call_start', id: 'review-read', name: 'read_file' };
        yield { type: 'tool_call_end', id: 'review-read', name: 'read_file', input: { path: 'seed.txt' } };
      } else if (scenario === 'memo_tool') {
        yield { type: 'tool_call_start', id: 'child-memo', name: 'record_memo' };
        yield { type: 'tool_call_end', id: 'child-memo', name: 'record_memo', input: { text: 'Preserve configuration files.', kind: 'warning' } };
      } else {
        yield { type: 'tool_call_start', id: 'child-write', name: 'create_file' };
        yield { type: 'tool_call_end', id: 'child-write', name: 'create_file', input: { path: 'child.txt', content: 'once' } };
      }
    } else {
      if (scenario === 'resume_tool') {
        expect(JSON.stringify(request.messages)).toContain('child-write');
        expect(JSON.stringify(request.messages)).toContain('tool_result');
        expect(JSON.stringify(request.messages)).toContain('Summarize the confirmed write without repeating it.');
      }
      if (scenario === 'adapter_resume') {
        expect(JSON.stringify(request.messages)).toContain('image/png');
        expect(JSON.stringify(request.messages)).toContain('iVBORw0KGgo');
        expect(JSON.stringify(request.messages)).toContain('tool_result');
        expect(JSON.stringify(request.messages)).toContain('Inspect the preserved image and summarize.');
      }
      childEntered.resolve(); await waitFor(childContinue.promise, request.signal);
      yield { type: 'text_delta', text: scenario === 'request_review' ? '<review>{"findings":[]}</review>' : 'Child complete' };
    }
    yield { type: 'done' };
  } };
  let verificationCalls = 0;
  const verificationProvider: ChatProvider = { name: 'openai', model: 'fixture', setModel() {}, async *chat(request) {
    verificationCalls++;
    expect(JSON.stringify(request.messages)).toContain('Child complete');
    if (verificationCalls === 1) {
      expect(await readFile(join(root, 'child.txt'), 'utf8')).toBe('once');
      yield { type: 'tool_call_start', id: 'workflow-verify-read', name: 'read_file' };
      yield { type: 'tool_call_end', id: 'workflow-verify-read', name: 'read_file', input: { path: 'child.txt' } };
    } else yield { type: 'text_delta', text: 'Verified child result' };
    yield { type: 'done' };
  } };
  try {
    rememberNativeProviderSelection(childProvider, { provider: 'openai', model: 'fixture' });
    rememberNativeProviderSelection(verificationProvider, { provider: 'openai', model: 'fixture' });
    if (parallelScenario || scenario === 'request_review') await writeFile(join(root, 'seed.txt'), 'shared read content');
    const parentPrepared = prepare(f.context, parentProvider, 'Wait for the child.');
    execution = await executeNativeCoder({ bridge: worker, runId: 1, bus: rootBus, assertOwner() {},
      tree: { maxAgents: 3, maxDepth: 2, maxParallel: parallelScenario || scenario === 'nested_progress' ? 2 : 1, ready: value => { owner = value; } },
      config, prepared: parentPrepared });
    await parentEntered.promise;
    if (scenario === 'uncertain_spawn') {
      await expect(execution.done).rejects.toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN' });
      expect(rootCalls).toBe(1); expect(calls).toBe(1);
      expect(await readFile(join(root, 'child.txt'), 'utf8')).toBe('once');
      expect((await f.repository.list('run')).items.map(row => row.data.run))
        .toEqual(expect.arrayContaining([expect.objectContaining({ terminalReason: 'outcome_unknown', status: 'failed' })]));
      expect(rootBus.buffer.some(event => event.event === 'tool_call_result'
        && (event.data as { result?: { effectOutcome?: string } }).result?.effectOutcome === 'unknown')).toBe(true);
      expect(JSON.parse(await readFile(join(leaseRoot, 'leases.json'), 'utf8')).state.leases).toHaveLength(2);
      reports.push({ scenario, passed: true, writeCount: 1, rootProviderCalls: rootCalls, childProviderCalls: calls,
        scope: 'real root spawn_agent tool propagates an uncertain child result without another provider turn' });
      if (process.env.MCP_NATIVE_CHILD_REPORT) await writeFile(process.env.MCP_NATIVE_CHILD_REPORT, JSON.stringify(reports, null, 2));
      return;
    }
    if (scenario === 'scoped_patch') {
      await writeFile(join(root, 'outside.txt'), 'preserve');
      let turns = 0;
      const provider: ChatProvider = { name: 'openai', model: 'fixture', setModel() {}, async *chat(request) {
        turns++;
        if (turns === 1) {
          yield { type: 'tool_call_start', id: 'mixed-patch', name: 'apply_patch' };
          yield { type: 'tool_call_end', id: 'mixed-patch', name: 'apply_patch', input: {
            patch: '*** Begin Patch\n*** Add File: child.txt\n+must not write partially\n*** Delete File: outside.txt\n*** End Patch' } };
        } else if (turns === 2) {
          expect(JSON.stringify(request.messages)).toContain('path scope violation');
          await expect(readFile(join(root, 'child.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await readFile(join(root, 'outside.txt'), 'utf8')).toBe('preserve');
          yield { type: 'tool_call_start', id: 'owned-patch', name: 'apply_patch' };
          yield { type: 'tool_call_end', id: 'owned-patch', name: 'apply_patch', input: {
            patch: '*** Begin Patch\n*** Add File: child.txt\n+owned write\n*** End Patch' } };
        } else yield { type: 'text_delta', text: 'Scoped patch complete' };
        yield { type: 'done' };
      } };
      rememberNativeProviderSelection(provider, { provider: 'openai', model: 'fixture' });
      const result = await runSubagent({ provider, tools: parentPrepared.registry.list(), ctx: parentPrepared.toolContext,
        sessionId: f.context.sessionId }, { systemPrompt: 'Edit only child.txt.', allowlist: new Set(['apply_patch']), maxTurns: 3,
        pathScope: ['child.txt'], pathScopeMode: 'enforce-writes', spawnId: 'scoped-patch',
        initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'Apply the patch.' }] }] });
      expect(result.reason).toBe('completed'); expect(result.sandboxViolations).toEqual(['apply_patch:outside.txt']);
      expect(await readFile(join(root, 'child.txt'), 'utf8')).toBe('owned write');
      expect(await readFile(join(root, 'outside.txt'), 'utf8')).toBe('preserve');
      parentContinue.resolve(); expect((await execution.done).reason).toBe('completed');
      expect((await f.repository.list('nativeActivation')).items).toHaveLength(2);
      expect(JSON.parse(await readFile(join(leaseRoot, 'leases.json'), 'utf8')).state.leases).toEqual([]);
      reports.push({ scenario, passed: true, durationMs: performance.now() - started,
        scope: 'Rust child refuses a mixed out-of-scope patch before any file effect, then commits a scoped patch' });
      if (process.env.MCP_NATIVE_CHILD_REPORT) await writeFile(process.env.MCP_NATIVE_CHILD_REPORT, JSON.stringify(reports, null, 2));
      return;
    }
    if (scenario === 'nested_progress') {
      let branchCalls = 0;
      const branchProvider: ChatProvider = { name: 'openai', model: 'fixture', setModel() {}, async *chat() {
        if (++branchCalls === 1) {
          yield { type: 'tool_call_start', id: 'spawn-grandchild', name: 'spawn_agent' };
          yield { type: 'tool_call_end', id: 'spawn-grandchild', name: 'spawn_agent', input: {
            agents: [{ task: 'Write child.txt once, then summarize.', profile: 'implement', max_turns: 3 }] } };
        } else yield { type: 'text_delta', text: 'Branch complete' };
        yield { type: 'done' };
      } };
      const task = 'Run the grandchild.';
      child = owner.runPrepared({ idempotencyKey: 'branch', role: 'coder', agentDefinitionId: 'coder',
        provider: 'openai', model: 'fixture', deadlineAtUnixMs: Date.now() + 30_000,
        taskSha256: createHash('sha256').update(toBinary(agentV1Runtime.TaskInputSchema,
          create(agentV1Runtime.TaskInputSchema, { body: { case: 'inlineUtf8', value: task } }))).digest('hex') },
      admission => prepare(admission.context, branchProvider, task));
      void child.catch(() => undefined);
      await Promise.race([childEntered.promise, child.then(() => { throw new Error('Grandchild ended before progress observation'); })]);
      const start = rootBus.buffer.find(event => event.event === 'agents_group_start')?.data as {
        groupId: string; nativeTree: { agentRunId: string; attemptId: string };
      };
      expect(start?.nativeTree.agentRunId).toBeTruthy(); expect(start.nativeTree.agentRunId).not.toBe(f.context.agentRunId);
      expect(rootBus.buffer.some(event => event.event === 'agent_progress'
        && (event.data as { groupId: string }).groupId === start.groupId)).toBe(true);
      expect(rootBus.buffer.some(event => event.event === 'agents_group_end')).toBe(false);
      expect(JSON.parse(await readFile(join(leaseRoot, 'leases.json'), 'utf8')).state.leases).toHaveLength(3);
      childContinue.resolve(); const outcome = await child;
      expect(outcome.outcome.reason).toBe('completed'); expect(outcome.finalText).toBe('Branch complete');
      const end = rootBus.buffer.find(event => event.event === 'agents_group_end')?.data;
      expect(end).toMatchObject({ groupId: start.groupId, nativeTree: start.nativeTree });
      expect(start.nativeTree.agentRunId).toBe(outcome.admission.context.agentRunId);
      expect(await readFile(join(root, 'child.txt'), 'utf8')).toBe('once');
      expect(owner.shared.budget.usage).toEqual({ turns: 5, toolCalls: 2, agents: 3 });
      parentContinue.resolve(); expect((await execution.done).reason).toBe('completed');
      expect((await f.repository.list('nativeActivation')).items).toHaveLength(3);
      expect(JSON.parse(await readFile(join(leaseRoot, 'leases.json'), 'utf8')).state.leases).toEqual([]);
      reports.push({ scenario, passed: true, durationMs: performance.now() - started,
        scope: 'root, child and grandchild Rust processes with live group progress before completion and stable UI identities' });
      if (process.env.MCP_NATIVE_CHILD_REPORT) await writeFile(process.env.MCP_NATIVE_CHILD_REPORT, JSON.stringify(reports, null, 2));
      return;
    }
    if (scenario === 'request_review') {
      await Promise.race([childEntered.promise, execution.done.then(() => { throw new Error('Review child ended prematurely'); })]);
      childContinue.resolve(); parentContinue.resolve(); expect((await execution.done).reason).toBe('completed');
      const results = rootBus.buffer.filter(event => event.event === 'tool_call_result').map(event => event.data);
      expect(results).toHaveLength(1); expect(JSON.stringify(results)).toContain('Reviewer found no issues');
      expect(JSON.stringify(results)).toContain('native-child-journal:');
      expect(owner.shared.budget.usage).toEqual({ turns: 4, toolCalls: 2, agents: 2 });
      expect((await f.repository.list('nativeActivation')).items).toHaveLength(2);
      expect(JSON.parse(await readFile(join(leaseRoot, 'leases.json'), 'utf8')).state.leases).toEqual([]);
      reports.push({ scenario, passed: true, durationMs: performance.now() - started,
        scope: 'request_review Host capability delegates a clean context to configured Rust reviewer and returns structured findings' });
      if (process.env.MCP_NATIVE_CHILD_REPORT) await writeFile(process.env.MCP_NATIVE_CHILD_REPORT, JSON.stringify(reports, null, 2));
      return;
    }
    if (parallelScenario) {
      const entered = [latch(), latch()], release = [latch(), latch()], reached = [false, false];
      const tools = scenario === 'parallel_writes' ? 'create_file' : 'read_file';
      const providers = entered.map((ready, index): ChatProvider => {
        let turns = 0;
        const provider: ChatProvider = { name: 'openai', model: 'fixture', setModel() {}, async *chat(request) {
          turns++;
          if (turns === 1) {
            const name = scenario === 'parallel_wait' && index === 1 ? 'wait_agents' : tools;
            if (name === 'wait_agents') await waitFor(entered[0]!.promise, request.signal);
            yield { type: 'tool_call_start', id: `parallel-${index}`, name };
            yield { type: 'tool_call_end', id: `parallel-${index}`, name, input: name === 'wait_agents'
              ? { agent_run_ids: [owner.list({})[1].agent_run_id], timeout_minutes: 1 } : tools === 'read_file'
              ? { path: 'seed.txt' } : { path: `child-${index}.txt`, content: `write ${index}` } };
          } else {
            if (scenario === 'parallel_wait' && index === 1) expect(JSON.stringify(request.messages)).toContain('All targeted agents finished');
            reached[index] = true; ready.resolve(); await waitFor(release[index]!.promise, request.signal);
            yield { type: 'text_delta', text: `Child ${index} done` };
          }
          yield { type: 'done' };
        } };
        rememberNativeProviderSelection(provider, { provider: 'openai', model: 'fixture' }); return provider;
      });
      const pending = runParallelAgents({ provider: parentProvider, tools: parentPrepared.registry.list(), ctx: parentPrepared.toolContext,
        sessionId: f.context.sessionId, maxParallel: 2 }, providers.map((provider, index) => ({ provider, task: `Work ${index}`,
          label: `Child ${index}`, maxTurns: 3, spawnId: 'shared-group' })), 'Execute the task.', new Set([tools, ...(scenario === 'parallel_wait' ? ['wait_agents'] : [])]), () => {});
      void pending.catch(() => undefined);
      try {
        await Promise.race([entered[0]!.promise, pending.then(() => { throw new Error('Parallel children ended before checkpoint'); })]);
        if (scenario === 'parallel_reads') {
          await Promise.race([entered[1]!.promise, pending.then(() => { throw new Error('Second reader did not overlap'); })]);
          expect(JSON.parse(await readFile(join(leaseRoot, 'leases.json'), 'utf8')).state.leases).toHaveLength(3);
        } else if (scenario === 'parallel_wait') {
          await vi.waitFor(() => expect(owner.shared.inventory.pendingWaitCount).toBe(1));
          expect(reached[1]).toBe(false); release[0]!.resolve();
          await Promise.race([entered[1]!.promise, pending.then(() => { throw new Error('Waiting sibling failed to continue'); })]);
          expect(owner.shared.inventory.pendingWaitCount).toBe(0);
        } else {
          expect(reached[1]).toBe(false); release[0]!.resolve();
          await Promise.race([entered[1]!.promise, pending.then(() => { throw new Error('Queued writer did not start'); })]);
          expect(await readFile(join(root, 'child-0.txt'), 'utf8')).toBe('write 0');
          expect(await readFile(join(root, 'child-1.txt'), 'utf8')).toBe('write 1');
        }
        release.forEach(value => value.resolve()); const outcome = await pending;
        expect(outcome.results.map(result => result.reason)).toEqual(['completed', 'completed']);
        expect(new Set(outcome.results.map(result => result.nativeTranscriptRef)).size).toBe(2);
        expect(outcome.results.every(result => result.nativeTranscriptRef?.startsWith('native-child-journal:'))).toBe(true);
        parentContinue.resolve(); expect((await execution.done).reason).toBe('completed');
        expect((await f.repository.list('nativeActivation')).items).toHaveLength(3);
        expect(owner.shared.budget.usage).toEqual({ turns: 5, toolCalls: 2, agents: 3 });
        expect(JSON.parse(await readFile(join(leaseRoot, 'leases.json'), 'utf8')).state.leases).toEqual([]);
        reports.push({ scenario, passed: true, durationMs: performance.now() - started,
          scope: 'two real Rust children with shared group ID; read overlap or sequential write barrier, unique journals' });
        if (process.env.MCP_NATIVE_CHILD_REPORT) await writeFile(process.env.MCP_NATIVE_CHILD_REPORT, JSON.stringify(reports, null, 2));
        return;
      } finally { release.forEach(value => value.resolve()); await pending.catch(() => undefined); }
    }
    if (scenario === 'inventory') {
      await Promise.race([childEntered.promise, execution.done.then(() => { throw new Error('Inventory child ended before live observation'); })]);
      const live = await parentPrepared.toolContext.ports!.agentTree!.list!({});
      expect(live).toHaveLength(2); expect(live.filter(m => m.is_self)).toHaveLength(1);
      expect(live[1]).toMatchObject({ status: 'running', is_alive: true });
      childContinue.resolve(); parentContinue.resolve(); expect((await execution.done).reason).toBe('completed');
      const result = rootBus.buffer.filter(event => event.event === 'tool_call_result').map(event => event.data)
        .find((data: any) => data.name === 'list_agents') as { result: { content: string; isError?: boolean } };
      expect(result.result.isError).not.toBe(true);
      const listed = JSON.parse(result.result.content);
      expect(listed.total).toBe(2); expect(listed.agents[1]).toMatchObject({ status: 'completed', is_alive: false });
      expect(listed.agents[1].agent_run_id).toBe(live[1].agent_run_id);
      expect(await readFile(join(root, 'child.txt'), 'utf8')).toBe('once');
      expect(JSON.parse(await readFile(join(leaseRoot, 'leases.json'), 'utf8')).state.leases).toEqual([]);
      reports.push({ scenario, passed: true, scope: 'live native child inventory and completed snapshot through a committed root list_agents capability' });
      if (process.env.MCP_NATIVE_CHILD_REPORT) await writeFile(process.env.MCP_NATIVE_CHILD_REPORT, JSON.stringify(reports, null, 2));
      return;
    }
    if (scenario === 'shared_budget') {
      await Promise.race([childEntered.promise, execution.done.then(() => { throw new Error('Budget stopped before the child completed its write'); })]);
      childContinue.resolve(); parentContinue.resolve();
      expect((await execution.done).reason).toBe('max_turns');
      expect(rootCalls).toBe(1); expect(calls).toBe(2);
      expect(await readFile(join(root, 'child.txt'), 'utf8')).toBe('once');
      expect(rootBus.buffer.filter(event => event.event === 'tool_call_result').map(event => event.data))
        .toEqual([expect.objectContaining({ name: 'spawn_agent', result: expect.objectContaining({ isError: false }) })]);
      expect(owner.shared.budget.usage).toEqual({ turns: 3, toolCalls: 2, agents: 2 });
      expect((await f.repository.list('nativeActivation')).items).toHaveLength(2);
      expect(JSON.parse(await readFile(join(leaseRoot, 'leases.json'), 'utf8')).state.leases).toEqual([]);
      reports.push({ scenario, passed: true, rootProviderCalls: rootCalls, childProviderCalls: calls,
        scope: 'shared root/child budget ends as max_turns, preserving the acknowledged child write and draining both processes' });
      if (process.env.MCP_NATIVE_CHILD_REPORT) await writeFile(process.env.MCP_NATIVE_CHILD_REPORT, JSON.stringify(reports, null, 2));
      return;
    }
    if (toolScenario) {
      if (scenario === 'resume_tool') {
        await vi.waitFor(() => expect(execution!.isInteractionPending?.(approvalId)).toBe(true), { timeout: 10_000 });
        await execution.resolveInteraction(approvalId, { idempotencyKey: 'approve-explicit-child-resume', value: JSON.stringify({ approved: true }) });
      }
      await Promise.race([childEntered.promise, execution.done.then(() => {
        throw new Error(`Root ended before the spawned child: ${JSON.stringify(rootBus.buffer.filter(event => event.event === 'tool_call_result').map(event => event.data)).slice(0, 6000)}`);
      })]);
      if (scenario !== 'memo_tool') expect(await readFile(join(root, 'child.txt'), 'utf8')).toBe('once');
      childContinue.resolve(); parentContinue.resolve(); expect((await execution.done).reason).toBe('completed');
      expect(rootBus.buffer.some(event => event.event === 'agents_group_start')).toBe(true);
      expect(rootBus.buffer.some(event => event.event === 'agents_group_end')).toBe(true);
      const results = rootBus.buffer.filter(event => event.event === 'tool_call_result').map(event => event.data as { name: string; result: string; isError?: boolean });
      expect(results).toEqual((scenario === 'resume_tool' ? ['spawn_agent', 'resume_agent', 'read_agent_transcript'] : ['spawn_agent', 'read_agent_transcript'])
        .map(name => expect.objectContaining({ name, result: expect.objectContaining({ isError: scenario === 'resume_tool' && name === 'spawn_agent' }) })));
      expect(JSON.stringify(results)).toContain('Child complete');
      const expectedDigest = scenario === 'resume_tool' ? 'Child complete' : scenario === 'memo_tool' ? 'Tool record_memo' : 'Tool create_file';
      expect(JSON.stringify(results.at(-1))).toContain(expectedDigest);
      if (scenario === 'memo_tool') expect(JSON.stringify(results[0])).toContain('Preserve configuration files.');
      const group = rootBus.buffer.find(event => event.event === 'agents_group_start')?.data as { groupId: string };
      const retained = await findRetainedAgent(f.context.sessionId, group.groupId, 0);
      expect(retained?.nativeTranscriptRef).toBeTruthy();
      const history = createNativeChildHistoryReader(worker, 1, config);
      expect(await history(retained!.nativeTranscriptRef!, { maxChars: 2000 })).toContain(expectedDigest);
      historyWorkerCold = true;
      const coldHistory = createNativeChildHistoryReader(worker, 0, { packageDirectory: config.packageDirectory,
        anchorPath: config.anchorPath, sessionRoot: config.sessionRoot });
      expect(await coldHistory(retained!.nativeTranscriptRef!, { maxChars: 2000 })).toContain(expectedDigest);
      if (scenario === 'resume_tool') {
        expect(retained!.attempt).toBe(2); expect(calls).toBe(2);
        expect(rootBus.buffer.filter(event => event.event === 'agents_group_start')).toHaveLength(2);
      }
      historyOwnerLive = false;
      await expect(history(retained!.nativeTranscriptRef!)).rejects.toThrow('Stale history worker');
      expect(owner.shared.budget.usage).toEqual(scenario === 'resume_tool' ? { turns: 6, toolCalls: 4, agents: 3 } : { turns: 5, toolCalls: 3, agents: 2 });
      expect((await f.repository.list('nativeActivation')).items).toHaveLength(scenario === 'resume_tool' ? 3 : 2);
      expect(JSON.parse(await readFile(join(leaseRoot, 'leases.json'), 'utf8')).state.leases).toEqual([]);
      reports.push({ scenario, passed: true, durationMs: performance.now() - started,
        scope: 'real spawn_agent Host capability creates Rust child through native tree port; deterministic provider, actual filesystem' });
      if (process.env.MCP_NATIVE_CHILD_REPORT) await writeFile(process.env.MCP_NATIVE_CHILD_REPORT, JSON.stringify(reports, null, 2));
      return;
    }
    if (scenario === 'adapter_resume') {
      const parent = { provider: childProvider, tools: parentPrepared.registry.list(), ctx: parentPrepared.toolContext, sessionId: f.context.sessionId };
      const spec = { systemPrompt: 'Write once, then summarize.', allowlist: new Set(['create_file']), maxTurns: 1, spawnId: 'image-child' };
      const first = await runSubagent(parent, { ...spec, initialMessages: [{ role: 'user', content: [
        { type: 'text', text: 'Write child.txt once.' }, { type: 'image', mediaType: 'image/png',
          base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=' },
      ] }] });
      expect(first.reason).toBe('max_turns'); expect(first.nativeTranscriptRef).toBeTruthy();
      const resumed = runSubagent(parent, { ...spec, spawnId: 'image-resume', nativeResumeRef: first.nativeTranscriptRef,
        initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect the preserved image and summarize.' }] }] });
      void resumed.catch(() => undefined);
      await Promise.race([childEntered.promise, resumed.then(() => { throw new Error('Resumed image child ended before provider'); })]);
      childContinue.resolve(); const result = await resumed;
      expect(result.reason).toBe('completed'); expect(result.nativeTranscriptRef).not.toBe(first.nativeTranscriptRef); expect(calls).toBe(2);
      expect(await readFile(join(root, 'child.txt'), 'utf8')).toBe('once');
      parentContinue.resolve(); expect((await execution.done).reason).toBe('completed');
      expect((await f.repository.list('nativeActivation')).items).toHaveLength(3);
      expect(owner.shared.budget.usage).toEqual({ turns: 3, toolCalls: 1, agents: 3 });
      expect(JSON.parse(await readFile(join(leaseRoot, 'leases.json'), 'utf8')).state.leases).toEqual([]);
      reports.push({ scenario, passed: true, durationMs: performance.now() - started,
        scope: 'Rust child resumes into a new journal, preserving image bytes and confirmed write without replay' });
      if (process.env.MCP_NATIVE_CHILD_REPORT) await writeFile(process.env.MCP_NATIVE_CHILD_REPORT, JSON.stringify(reports, null, 2));
      return;
    }
    if (scenario === 'uncertain_child') {
      const result = await runSubagent({ provider: childProvider, tools: parentPrepared.registry.list(), ctx: parentPrepared.toolContext,
        sessionId: f.context.sessionId }, { systemPrompt: 'Write once.', allowlist: new Set(['create_file']),
        maxTurns: 3, spawnId: 'uncertain-child', initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'Write child.txt once.' }] }] });
      expect(result).toMatchObject({ reason: 'error', effectOutcome: 'unknown' });
      expect(result.failureDetail).toContain('TOOL_OUTCOME_UNKNOWN');
      expect(calls).toBe(1);
      expect(await readFile(join(root, 'child.txt'), 'utf8')).toBe('once');
      expect((await f.repository.list('run')).items.map(row => row.data.run))
        .toContainEqual(expect.objectContaining({ terminalReason: 'outcome_unknown' }));
      const leases = JSON.parse(await readFile(join(leaseRoot, 'leases.json'), 'utf8')).state.leases;
      expect(leases).toHaveLength(2);
      const parentLease = leases.find((lease: { attemptId: string }) => lease.attemptId === f.context.attemptId);
      expect(() => NativeWorkspaceLeaseStore.verifier(leaseRoot).assertCurrentForMutation(parentLease)).toThrow(/child|descendant/i);
      parentContinue.resolve(); await expect(execution.done).rejects.toThrow();
      expect(JSON.parse(await readFile(join(leaseRoot, 'leases.json'), 'utf8')).state.leases).toHaveLength(2);
      reports.push({ scenario, passed: true, writeCount: 1, childProviderCalls: calls, workspaceReleased: false,
        scope: 'real Rust child, applied filesystem effect with uncertain acknowledgement, durable fence retained' });
      if (process.env.MCP_NATIVE_CHILD_REPORT) await writeFile(process.env.MCP_NATIVE_CHILD_REPORT, JSON.stringify(reports, null, 2));
      return;
    }
    if (scenario === 'adapter' || scenario === 'adapter_cancel') {
      rememberNativeProviderSelection(childProvider, { provider: 'openai', model: 'fixture' });
      const caller = new AbortController();
      const subagent = runSubagent({ provider: childProvider, tools: parentPrepared.registry.list(), ctx: parentPrepared.toolContext,
        sessionId: f.context.sessionId }, { systemPrompt: 'Use only create_file, then finish.', allowlist: new Set(['create_file']),
        maxTurns: 3, signal: caller.signal, spawnId: 'adapter-child', initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'Write child.txt once.' }] }] });
      void subagent.catch(() => undefined);
      await Promise.race([childEntered.promise, subagent.then(() => { throw new Error('Child ended before expected provider boundary'); })]);
      expect(await readFile(join(root, 'child.txt'), 'utf8')).toBe('once');
      if (scenario === 'adapter_cancel') caller.abort(new Error('Cancel only this child'));
      else childContinue.resolve();
      const result = await subagent;
      expect(result.reason).toBe(scenario === 'adapter_cancel' ? 'aborted' : 'completed');
      if (scenario === 'adapter') expect(result.finalText).toBe('Child complete');
      expect(result.nativeTranscriptRef).toMatch(/^native-child-journal:/); expect(result.transcript).toBeUndefined();
      const digest = await parentPrepared.toolContext.ports!.agentTree!.readTranscript!(result.nativeTranscriptRef!, { maxChars: 2000 });
      expect(digest.length).toBeLessThanOrEqual(2000); expect(digest).toContain('Tool create_file');
      const reconciliation = await owner.reconcile(result.nativeTranscriptRef!, {});
      expect(reconciliation, reconciliation.detail).toMatchObject(scenario === 'adapter'
        ? { outcome: 'terminal', stepStatus: 'completed' }
        : { outcome: 'outcome_unknown', detail: 'child journal has missing or uncertain effect receipts' });
      await expect(parentPrepared.toolContext.ports!.agentTree!.readTranscript!('native-child-journal:foreign', {})).rejects.toThrow('Invalid');
      expect(owner.shared.budget.usage).toEqual({ turns: 3, toolCalls: 1, agents: 2 });
      parentContinue.resolve(); expect((await execution.done).reason).toBe('completed');
      expect((await f.repository.list('nativeActivation')).items).toHaveLength(2);
      expect(JSON.parse(await readFile(join(leaseRoot, 'leases.json'), 'utf8')).state.leases).toEqual([]);
      reports.push({ scenario, passed: true, durationMs: performance.now() - started,
        scope: 'runSubagent through AgentTreePort to actual Rust child and durable facade, deterministic configured provider' });
      if (process.env.MCP_NATIVE_CHILD_REPORT) await writeFile(process.env.MCP_NATIVE_CHILD_REPORT, JSON.stringify(reports, null, 2));
      return;
    }
    if (scenario === 'workflow_tool' || scenario === 'workflow_uncertain') {
      if (scenario === 'workflow_uncertain') {
        await expect(execution.done).rejects.toThrow();
        expect(rootCalls).toBe(1); expect(calls).toBe(1);
        expect(rootBus.buffer.some(event => event.event === 'tool_call_result'
          && (event.data as { result?: { effectOutcome?: string } }).result?.effectOutcome === 'unknown')).toBe(true);
        expect(JSON.parse(await readFile(join(leaseRoot, 'leases.json'), 'utf8')).state.leases).toHaveLength(2);
      } else {
        await Promise.race([childEntered.promise, execution.done.then(() => { throw new Error('Root ended before workflow child'); })]);
        childContinue.resolve(); parentContinue.resolve();
        expect((await execution.done).reason).toBe('completed');
        expect(rootBus.buffer.some(event => event.event === 'workflow_run_finished'
          && (event.data as { status?: string }).status === 'completed')).toBe(true);
        expect(JSON.parse(await readFile(join(leaseRoot, 'leases.json'), 'utf8')).state.leases).toEqual([]);
      }
      expect(await readFile(join(root, 'child.txt'), 'utf8')).toBe('once');
      const records = await f.sessions.listOrchestrationCheckpoints(f.context.sessionId, 'workflow');
      expect(records).toHaveLength(1);
      expect(JSON.parse(records[0].payload_json).steps[0]).toMatchObject({
        status: scenario === 'workflow_uncertain' ? 'failed' : 'completed', nativeTranscriptRef: expect.stringMatching(/^native-child-journal:/),
        ...(scenario === 'workflow_uncertain' ? { effectOutcome: 'unknown' } : {}) });
      expect(verificationCalls).toBe(scenario === 'workflow_uncertain' ? 0 : 2);
      expect(JSON.parse(records[0].payload_json).steps[1].status).toBe(scenario === 'workflow_uncertain' ? 'skipped' : 'completed');
      reports.push({ scenario, passed: true, rootProviderCalls: rootCalls, childProviderCalls: calls, verificationCalls,
        scope: 'root Rust workflow capability, durable child checkpoint, native child effect, terminal projection and uncertainty propagation' });
      if (process.env.MCP_NATIVE_CHILD_REPORT) await writeFile(process.env.MCP_NATIVE_CHILD_REPORT, JSON.stringify(reports, null, 2));
      return;
    }
    if (scenario === 'workflow_recovery') {
      rememberNativeProviderSelection(childProvider, { provider: 'openai', model: 'fixture' });
      const workflow = buildWorkflowTool({ provider: parentProvider, subagentProvider: childProvider,
        parentTools: parentPrepared.registry.list(), sessionStore: f.sessions });
      const pending = workflow.handler({ steps: [{ id: 'write_once', prompt: 'Write child.txt once, then summarize.',
        profile: 'implement', files: ['child.txt'] }] }, parentPrepared.toolContext);
      void pending.catch(() => undefined);
      await Promise.race([childEntered.promise, pending.then(result => { throw new Error(`Workflow ended before child checkpoint: ${result.content}`); })]);
      const checkpoints = await f.sessions.listOrchestrationCheckpoints(f.context.sessionId, 'workflow');
      expect(checkpoints).toHaveLength(1);
      const persisted = JSON.parse(checkpoints[0].payload_json);
      expect(persisted.runtimeGeneration).toBe('rust_v1');
      expect(persisted.steps[0]).toMatchObject({ status: 'running', nativeTranscriptRef: expect.stringMatching(/^native-child-journal:/) });
      expect(await readFile(join(root, 'child.txt'), 'utf8')).toBe('once');
      expect(rootBus.buffer.some(event => event.event === 'workflow_step_update')).toBe(true);
      childContinue.resolve();
      const result = await pending;
      expect(result.isError, result.content).not.toBe(true);
      const record = await getWorkflow(f.context.sessionId, persisted.id, f.sessions);
      expect(record?.steps[0].status).toBe('completed');
      // Simulate loss of the wave's final checkpoint while retaining its
      // pre-dispatch journal identity. Recovery must inspect, never relaunch.
      record!.steps[0].status = 'running'; record!.steps[0].summary = undefined;
      await saveWorkflow(f.context.sessionId, record!, f.sessions);
      await clearWorkflows(f.context.sessionId);
      const before = calls;
      const recovered = await workflow.handler({ resume_workflow_id: persisted.id, retry_failed: true }, parentPrepared.toolContext);
      expect(recovered.isError, recovered.content).not.toBe(true);
      expect(recovered.content).toContain('Child complete'); expect(calls).toBe(before);
      expect(await readFile(join(root, 'child.txt'), 'utf8')).toBe('once');
      await clearWorkflows(f.context.sessionId);
      parentContinue.resolve(); expect((await execution.done).reason).toBe('completed');
      expect((await f.repository.list('nativeActivation')).items).toHaveLength(2);
      expect(JSON.parse(await readFile(join(leaseRoot, 'leases.json'), 'utf8')).state.leases).toEqual([]);
      reports.push({ scenario, passed: true, childProviderCalls: calls, replayedProviderCalls: calls - before,
        scope: 'workflow durable admission before child effects; recovery from lost wave checkpoint verifies complete journal and physical reap' });
      if (process.env.MCP_NATIVE_CHILD_REPORT) await writeFile(process.env.MCP_NATIVE_CHILD_REPORT, JSON.stringify(reports, null, 2));
      return;
    }
    const task = 'Write child.txt once.';
    const request = { idempotencyKey: 'child:1', role: 'coder', agentDefinitionId: 'coder', provider: 'openai', model: 'fixture',
      deadlineAtUnixMs: Date.now() + 30_000,
      taskSha256: createHash('sha256').update(toBinary(agentV1Runtime.TaskInputSchema,
        create(agentV1Runtime.TaskInputSchema, { body: { case: 'inlineUtf8', value: task } }))).digest('hex') };
    child = owner.runPrepared(request, (admission) => {
      if (scenario === 'preparation_failure') throw new Error('Rejected child preparation');
      const prepared = prepare(admission.context, childProvider, task);
      if (scenario === 'approval' || scenario === 'denial') prepared.preparation.policy.permissionMode = 'ask';
      return prepared;
    });
    void child.catch(() => undefined);
    if (scenario === 'preparation_failure') {
      await expect(child).rejects.toThrow('Rejected child preparation');
      expect((await f.repository.list('run')).items.map(row => row.data.status).sort()).toEqual(['failed', 'running']);
      parentContinue.resolve(); await execution.done;
    } else {
      if (scenario === 'approval' || scenario === 'denial') {
        await vi.waitFor(() => expect(execution!.isInteractionPending?.(approvalId)).toBe(true), { timeout: 10_000 });
        expect(execution.isWaitingForInput?.()).toBe(true);
        await expect(readFile(join(root, 'child.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
        const response = { idempotencyKey: 'parent-ui-approval', value: JSON.stringify({ approved: scenario === 'approval' }) };
        await execution.resolveInteraction(approvalId, response);
        await execution.resolveInteraction(approvalId, response);
      }
      await childEntered.promise;
      const leases = JSON.parse(await readFile(join(leaseRoot, 'leases.json'), 'utf8')).state.leases;
      expect(leases).toHaveLength(2);
      const parentLease = leases.find((lease: { attemptId: string }) => lease.attemptId === f.context.attemptId);
      expect(() => NativeWorkspaceLeaseStore.verifier(leaseRoot).assertCurrentForMutation(parentLease)).toThrow(/child|descendant/i);
      expect(() => owner.runPrepared({ ...request, idempotencyKey: 'child:2' }, () => { throw new Error('must not prepare'); })).toThrow('parallel process budget');
      if (scenario === 'denial') await expect(readFile(join(root, 'child.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await readFile(join(root, 'child.txt'), 'utf8')).toBe('once');
      if (scenario === 'cancel') {
        await execution.cancel({ code: 'user_cancelled' });
        const result = await child;
        expect(result.outcome.reason).toBe('aborted');
        expect((await execution.done).reason).toBe('aborted');
      } else {
        childContinue.resolve(); const result = await child;
        expect(result.outcome.reason).toBe('completed'); expect(result.finalText).toBe('Child complete');
        expect(result.transcriptRef).toContain(result.admission.context.attemptId);
        expect((await f.store.getAttemptState(f.context)).run.status).toBe('running');
        expect(owner.shared.budget.usage).toEqual({ turns: 3, toolCalls: scenario === 'denial' ? 0 : 1, agents: 2 });
        expect(NativeWorkspaceLeaseStore.verifier(leaseRoot).assertCurrentForMutation(parentLease)).toBeUndefined();
        const childJournal = join(nativeChildSessionRoot(sessionRoot, result.admission.context), f.context.sessionId, 'session.json');
        expect(JSON.parse(await readFile(childJournal, 'utf8'))).toBeTruthy();
        const runtimePackage = await verifyRuntimePackage(resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
          parseRuntimePackageAnchor(await readFile(resolve('dist/apps/electron/native-agent-runtime-integrity.json'))));
        expect(await f.store.reconcileNativeSupervisor(result.admission.context, { rootPath: sessionRoot, runtimePackage }))
          .toMatchObject({ supervisorReaped: true, hostEffectsReconciled: false });
        await expect(owner.runPrepared(request, () => { throw new Error('never relaunch'); })).rejects.toThrow('already exists');
        parentContinue.resolve(); expect((await execution.done).reason).toBe('completed');
      }
      expect((await f.repository.list('nativeActivation')).items).toHaveLength(2);
      expect((await f.repository.list('supervisorFact')).items).toHaveLength(10);
    }
    expect(JSON.parse(await readFile(join(leaseRoot, 'leases.json'), 'utf8')).state.leases).toEqual([]);
    reports.push({ scenario, passed: true, durationMs: performance.now() - started, childProviderCalls: calls,
      workspaceReleased: true, scope: 'executeNativeCoder and facade for root plus child, real Rust and filesystem, deterministic provider' });
    if (process.env.MCP_NATIVE_CHILD_REPORT) await writeFile(process.env.MCP_NATIVE_CHILD_REPORT, JSON.stringify(reports, null, 2));
  } finally {
    parentContinue.resolve(); childContinue.resolve(); rootBus.ctrl.abort();
    if (execution) { await execution.cancel({ code: 'user_cancelled' }).catch(() => undefined); await execution.done.catch(() => undefined); }
    await child?.catch(() => undefined);
    offHistory(); main.dispose(); worker.dispose(); channels.port1.close(); channels.port2.close();
    await clearWorkflows(f.context.sessionId);
    await f.sessions.close(); await rm(f.directory, { recursive: true, force: true });
    if (owner) expect(owner.shared.resources.snapshot()).toEqual({ memoryBytes: 0, processes: 0, groups: 0 });
    if (owner) expect(owner.shared.resources.snapshot()).toEqual({ memoryBytes: 0, processes: 0, groups: 0 });
  }
}, 75_000);
