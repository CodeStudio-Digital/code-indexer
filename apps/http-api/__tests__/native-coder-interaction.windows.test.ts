import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import { askUser, decisionGate } from '@mcp/code-agent/tools/interaction.js';
import { submitPlan } from '@mcp/code-agent/tools/plan.js';
import { prepareCoderAttempt } from '@mcp/code-agent/runtime/attempt-preparation.js';
import type { PreparedCoderExecution } from '@mcp/code-agent/runtime/prepared-coder-execution.js';
import type { ChatProvider } from '@mcp/provider-sdk/adapter.js';
import { executeNativeCoder } from '../workers/native-coder-execution.js';
import { dispatchNativeAuthority, type NativeAuthorityOperation } from '../workers/native-authority-bridge.js';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';
import { createBus } from '../coder-bus.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
physicalIt.each(['question', 'decision', 'approve', 'revise', 'cancel'] as const)(
  'runs a keyed human review through the native provider and Host capability: %s', async scenario => {
    const product = await supervisorFactFixture('coder');
    const ports = new MessageChannel();
    const main = new MessageBridge({ port: ports.port1 }); const worker = new MessageBridge({ port: ports.port2 });
    const bus = createBus(new AbortController()); const root = join(product.directory, 'project');
    let execution!: PreparedCoderExecution; let ready!: () => void;
    const handleReady = new Promise<void>(resolve => { ready = resolve; });
    const responses: Promise<void>[] = []; const reviewEvents: string[] = []; let calls = 0;
    main.handle('native.authority', payload => dispatchNativeAuthority({ authority: product.store, context: product.context,
      operation: (payload as { operation: NativeAuthorityOperation }).operation, assertOwner() {} }));
    bus.subscribers.add(event => {
      if (!['question', 'decision', 'plan'].includes(event.event)) return;
      reviewEvents.push(event.event);
      const response = (async () => {
        await handleReady;
        const id = (event.data as { id: string }).id;
        expect(id).toMatch(/^native-tool:/); expect(execution.isWaitingForInput?.()).toBe(true);
        await expect(execution.provideInput('native-tool:unknown', '{"approved":true}'))
          .rejects.toMatchObject({ code: 'INTERACTION_NOT_PENDING' });
        expect((await product.repository.list('runtimeRequest')).items.some(row =>
          String(row.data.key).includes('native-tool:unknown'))).toBe(false);
        expect(existsSync(join(root, 'before.txt'))).toBe(false);
        expect(existsSync(join(root, 'after.txt'))).toBe(false);
        if (scenario === 'cancel') { await execution.cancel({ code: 'user_cancelled' }); return; }
        const value = scenario === 'question' ? { answer: 'option-b' }
          : scenario === 'decision' ? { answers: { scope: { selected: ['b'] } } }
          : { approved: scenario === 'approve', feedback: scenario === 'revise' ? 'Read more' : undefined };
        await execution.provideInput(id, JSON.stringify(value));
      })();
      void response.catch(cause => bus.ctrl.abort(cause)); responses.push(response);
    });
    try {
      const registry = new ToolRegistry();
      for (const tool of [askUser, decisionGate, submitPlan, fsTools.find(tool => tool.name === 'create_file')!]) registry.register(tool);
      registry.seal();
      const systemPrompt = 'Ask the user, then act only within the approved plan.';
      const preparation = prepareCoderAttempt({ sessionId: product.context.sessionId, agentRunId: product.context.agentRunId,
        runnerRunId: 'native-review', provider: 'openai', model: 'fixture', agentDefinitionId: 'plan', capabilityProfile: 'full',
        systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'), environment: { kind: 'host', cwd: root },
        policy: { permissionMode: 'unrestricted', planMode: true, specMode: false } }, registry);
      const planReview = scenario === 'approve' || scenario === 'revise';
      const review = planReview ? { id: 'review', name: 'submit_plan', input: { plan: 'Create after.txt after approval.' } }
        : scenario === 'decision' ? { id: 'review', name: 'decision_gate', input: { questions: [{ id: 'scope', question: 'Choose scope', options: [
          { label: 'A', value: 'a', summary: 'First' }, { label: 'B', value: 'b', summary: 'Second' },
        ] }] } } : { id: 'review', name: 'ask_user', input: { question: 'Choose scope' } };
      const provider: ChatProvider = { name: 'openai', model: 'fixture', setModel() {}, async *chat(request) {
        if (++calls === 1) {
          const tools = planReview ? [
            { id: 'before', name: 'create_file', input: { path: 'before.txt', content: 'forbidden' } }, review,
            { id: 'after', name: 'create_file', input: { path: 'after.txt', content: 'approved' } },
          ] : [review];
          for (const tool of tools) { yield { type: 'tool_call_start', id: tool.id, name: tool.name }; yield { type: 'tool_call_end', ...tool }; }
        } else {
          const history = JSON.stringify(request.messages);
          expect(history).toContain(scenario === 'question' ? 'User answered: option-b' : scenario === 'decision' ? 'scope: B'
            : scenario === 'approve' ? 'Plan approved by user' : 'Plan revision requested by user');
          expect(existsSync(join(root, 'before.txt'))).toBe(false);
          expect(existsSync(join(root, 'after.txt'))).toBe(scenario === 'approve');
          if (scenario === 'approve') expect(history).toContain('Mode transition: Plan');
          yield { type: 'text_delta', text: 'review completed' };
        }
        yield { type: 'done' };
      } };
      execution = await executeNativeCoder({ bridge: worker, runId: 1, bus, assertOwner() {},
        config: { mode: 'test', context: product.context, packageDirectory: resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
          anchorPath: resolve('dist/apps/electron/native-agent-runtime-integrity.json'), sessionRoot: join(product.directory, 'native-sessions'),
          workspaceRoot: root, workspaceLeaseRoot: join(product.directory, 'native-workspace-leases') },
        prepared: { preparation, registry, provider, systemPrompt, thinking: false, maxTurns: 3,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Review the scope with me' }] }],
          toolContext: { cwd: root, projectName: 'native-review', signal: bus.ctrl.signal,
            recordPlan: (id, text) => product.sessions.recordPlan({ session_id: product.context.sessionId, tool_use_id: id, plan_text: text }).then(() => {}),
            resolvePlan: async (id, status, feedback) => { await product.sessions.resolvePlan(product.context.sessionId, id, status, feedback); },
            setSessionAgent: agent => product.sessions.setSessionAgent(product.context.sessionId, agent),
          }, signal: bus.ctrl.signal } });
      ready(); await execution.done; await Promise.all(responses);
      expect(reviewEvents).toEqual([planReview ? 'plan' : scenario === 'decision' ? 'decision' : 'question']);
      expect(calls).toBe(scenario === 'cancel' ? 1 : 2);
      expect(execution.isWaitingForInput?.()).toBe(false);
      expect((await product.store.getAttemptState(product.context, false)).run.status).toBe(scenario === 'cancel' ? 'interrupted' : 'completed');
      if (planReview) expect((await product.sessions.listPlans(product.context.sessionId))[0]?.status).toBe(scenario === 'approve' ? 'approved' : 'rejected');
      const leases = JSON.parse(await readFile(join(product.directory, 'native-workspace-leases', 'leases.json'), 'utf8'));
      expect(leases.state.leases).toEqual([]);
    } finally {
      bus.ctrl.abort(); main.dispose(); worker.dispose(); ports.port1.close(); ports.port2.close();
      await product.sessions.close(); await rm(product.directory, { recursive: true, force: true });
    }
  }, 60_000);
