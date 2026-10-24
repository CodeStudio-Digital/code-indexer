import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { MessageChannel } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { NativeSessionReader, parseRuntimePackageAnchor, verifyRuntimePackage } from '@mcp/agent-runtime-host';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import { worktreeTools } from '@mcp/code-agent/tools/worktree.js';
import { prepareCoderAttempt } from '@mcp/code-agent/runtime/attempt-preparation.js';
import type { PreparedCoderExecution } from '@mcp/code-agent/runtime/prepared-coder-execution.js';
import type { NativeCoderDevelopmentConfig } from '../workers/native-coder-execution.js';
import { executeNativeCoderWithWorkspaceTransitions } from '../workers/native-coder-workspace-execution.js';
import { dispatchNativeAuthority, type NativeAuthorityOperation } from '../workers/native-authority-bridge.js';
import { admitNativeWorktreeContinuation } from '../native-worktree-continuation-admission.js';
import { projectNativeSessionHistory } from '../native-session-history.js';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';
import { createBus } from '../coder-bus.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
physicalIt.each([{ action: 'keep', restart: false }, { action: 'remove', restart: false }, { action: 'keep', restart: true }] as const)('switches native attempts into and out of a real worktree (%j), refusing remaining old-cwd tools', async ({ action, restart }) => {
  const f = await supervisorFactFixture('coder'); const root = join(f.directory, 'project');
  const ports = new MessageChannel(); const main = new MessageBridge({ port: ports.port1 }); const worker = new MessageBridge({ port: ports.port2 });
  let bus = createBus(new AbortController()); let execution: PreparedCoderExecution | undefined;
  let config: NativeCoderDevelopmentConfig = { mode: 'test', context: f.context,
    packageDirectory: resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
    anchorPath: resolve('dist/apps/electron/native-agent-runtime-integrity.json'),
    sessionRoot: join(f.directory, 'native-sessions'), workspaceRoot: root, workspaceLeaseRoot: join(f.directory, 'native-workspace-leases') };
  const attempts = new Set<string>([f.context.attemptId]); const contexts = [f.context]; let calls = 0; let worktree: string | null = null;
  let interruptBeforeTransition = restart;
  main.handle('native.authority', payload => dispatchNativeAuthority({ authority: f.store, context: config.context,
    ...(payload as { agentRunId?: string; operation: NativeAuthorityOperation }), assertOwner() {} }));
  main.handle('native.workspaceTransition', async payload => {
    const request = payload as { sourceAttemptId: string; transitionId: string };
    expect(request.sourceAttemptId).toBe(config.context.attemptId);
    expect(JSON.parse(await readFile(join(config.workspaceLeaseRoot, 'leases.json'), 'utf8')).state.leases).toEqual([]);
    const next = await admitNativeWorktreeContinuation(f.store, config, request.transitionId, () => {}, bus.ctrl.signal);
    attempts.add(next.attemptId); contexts.push(next); config = { ...config, context: next }; return next;
  });
  try {
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 10_000 });
    git(['init', '--initial-branch=main']); await writeFile(join(root, 'seed.txt'), 'main'); git(['add', 'seed.txt']);
    git(['-c', 'user.name=Harness', '-c', 'user.email=harness@example.invalid', 'commit', '-m', 'fixture']);
    const registry = new ToolRegistry();
    for (const tool of [...worktreeTools, ...fsTools.filter(tool => ['create_file', 'read_file'].includes(tool.name))]) registry.register(tool);
    registry.seal(); const systemPrompt = 'Use the selected native workspace.';
    const preparation = prepareCoderAttempt({ sessionId: f.context.sessionId, agentRunId: f.context.agentRunId,
      runnerRunId: 'native-worktree-transitions', provider: 'openai', model: 'fixture', agentDefinitionId: 'coder', capabilityProfile: 'full',
      systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'), environment: { kind: 'host', cwd: root },
      policy: { permissionMode: 'unrestricted', planMode: false, specMode: false } }, registry);
    const runtime = await verifyRuntimePackage(config.packageDirectory, parseRuntimePackageAnchor(await readFile(config.anchorPath)));
    const input: Parameters<typeof executeNativeCoderWithWorkspaceTransitions>[0] = { config, bridge: worker, runId: 1, bus, assertOwner() {},
      persistWorktree: async path => { worktree = path; await f.sessions.setSessionWorktree(f.context.sessionId, path); },
      loadMessages: async () => {
        if (interruptBeforeTransition) { interruptBeforeTransition = false; throw new Error('fixture process stopped after settled workspace boundary'); }
        const reader = await NativeSessionReader.open(runtime, { rootPath: config.sessionRoot, sessionId: f.context.sessionId });
        try { return (await projectNativeSessionHistory(reader, f.context.sessionId, new Date().toISOString(), async id => attempts.has(id))).messages; }
        finally { await reader.close(); }
      },
      prepared: { preparation, registry, systemPrompt, thinking: false, maxTurns: 8,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Enter an isolated worktree, write, leave, then write in main.' }] }],
        toolContext: { cwd: root, projectName: 'worktree-transition', signal: bus.ctrl.signal, runtimeGeneration: 'rust_v1' }, signal: bus.ctrl.signal,
        provider: { name: 'openai', model: 'fixture', setModel() {}, async *chat(request) {
          const turn = ++calls;
          const tool = (id: string, name: string, input: Record<string, unknown>) => [
            { type: 'tool_call_start' as const, id, name }, { type: 'tool_call_end' as const, id, name, input }];
          if (turn === 1) {
            for (const event of [...tool('enter', 'enter_worktree', { name: `physical-${action}` }),
              ...tool('must-not-run', 'create_file', { path: 'wrong-root.txt', content: 'forbidden' })]) yield event;
          } else if (turn === 2) {
            expect(worktree).not.toBeNull(); expect(existsSync(join(root, 'wrong-root.txt'))).toBe(false);
            expect(JSON.stringify(request.messages)).toContain('workspace_transition');
            for (const event of [...tool('inside', 'create_file', { path: 'inside.txt', content: 'worktree-owned' }),
              ...tool('exit', 'exit_worktree', { action, discard_changes: action === 'remove' }),
              ...tool('must-wait', 'create_file', { path: 'too-early.txt', content: 'forbidden' })]) yield event;
          } else if (turn === 3) {
            expect(worktree).toBeNull(); expect(existsSync(join(root, 'inside.txt'))).toBe(false);
            for (const event of tool('outside', 'create_file', { path: 'outside.txt', content: 'main-owned' })) yield event;
          } else {
            expect(turn).toBe(4); yield { type: 'text_delta', text: 'Native workspace transition complete.' };
          }
          yield { type: 'done' };
        } } } };
    execution = await executeNativeCoderWithWorkspaceTransitions(input);
    if (restart) {
      await expect(execution.done).rejects.toThrow('fixture process stopped');
      expect((await f.store.getAttemptState(config.context, false)).run).toMatchObject({ status: 'interrupted', terminalReason: 'workspace_transition' });
      expect(worktree).toBeNull();
      const { readNativeWorktreeTransition } = await import('../workers/native-worktree-transition-recovery.js');
      const { intent } = await readNativeWorktreeTransition(config, new AbortController().signal);
      const next = await admitNativeWorktreeContinuation(f.store, config, intent.id, () => {}, new AbortController().signal);
      attempts.add(next.attemptId); contexts.push(next); config = { ...config, context: next };
      bus = createBus(new AbortController());
      execution = await executeNativeCoderWithWorkspaceTransitions({ ...input, config, bus, prepared: { ...input.prepared,
        messages: await input.loadMessages(), resume: true, signal: bus.ctrl.signal,
        preparation: { ...preparation, agentRunId: next.agentRunId, capabilitySet: { ...preparation.capabilitySet, agentRunId: next.agentRunId } },
        toolContext: { cwd: root, projectName: 'worktree-transition', signal: bus.ctrl.signal, runtimeGeneration: 'rust_v1' } } });
    }
    expect((await execution.done).reason).toBe('completed'); expect(calls).toBe(4); expect(contexts).toHaveLength(3);
    expect(new Set(contexts.map(context => context.attemptId)).size).toBe(3);
    for (const context of contexts.slice(0, -1)) expect((await f.store.getAttemptState(context, false)).run).toMatchObject({ status: 'interrupted', terminalReason: 'workspace_transition' });
    expect(await readFile(join(root, 'outside.txt'), 'utf8')).toBe('main-owned');
    expect(existsSync(join(root, 'wrong-root.txt'))).toBe(false); expect(existsSync(join(root, 'too-early.txt'))).toBe(false);
    const isolated = join(root, '.mcp-indexer/worktrees', `physical-${action}`);
    expect(existsSync(isolated)).toBe(action === 'keep');
    if (action === 'keep') expect(await readFile(join(isolated, 'inside.txt'), 'utf8')).toBe('worktree-owned');
    expect(git(['branch', '--show-current']).trim()).toBe('main');
    expect(JSON.parse(await readFile(join(config.workspaceLeaseRoot, 'leases.json'), 'utf8')).state.leases).toEqual([]);
    expect(bus.ended).toBe(true); expect(bus.endReason?.event).toBe('done');
  } catch (cause) {
    console.error('WORKTREE_TRANSITION_DIAGNOSTIC', JSON.stringify({ action, calls, attempts: contexts.length,
      events: bus.buffer.slice(-8).map(event => ({ event: event.event, data: event.data })),
      state: (await f.store.getAttemptState(config.context, false)).run }));
    throw cause;
  } finally {
    bus.ctrl.abort(); if (execution) { await execution.cancel({ code: 'test_cleanup' }).catch(() => undefined); await execution.done.catch(() => undefined); }
    main.dispose(); worker.dispose(); ports.port1.close(); ports.port2.close(); await f.sessions.close();
    if (dirname(resolve(f.directory)) !== resolve(tmpdir()) || !basename(f.directory).startsWith('codestudio-supervisor-facts-')) throw new Error('Unexpected fixture cleanup path');
    await rm(f.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 120_000);
