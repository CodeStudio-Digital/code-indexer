import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import { prepareCoderAttempt } from '@mcp/code-agent/runtime/attempt-preparation.js';
import type { PreparedCoderExecution } from '@mcp/code-agent/runtime/prepared-coder-execution.js';
import { executeNativeCoder, type NativeCoderDevelopmentConfig } from '../workers/native-coder-execution.js';
import { prepareNativeCoderWorkspace, verifyNativeCoderWorkspace } from '../workers/native-worktree-preparation.js';
import { dispatchNativeAuthority, type NativeAuthorityOperation } from '../workers/native-authority-bridge.js';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';
import { createBus } from '../coder-bus.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;

physicalIt('creates and reopens an owned Git worktree before sealing the native mutation root', async () => {
  const f = await supervisorFactFixture('coder');
  const root = join(f.directory, 'project');
  const ports = new MessageChannel();
  const main = new MessageBridge({ port: ports.port1 });
  const worker = new MessageBridge({ port: ports.port2 });
  const bus = createBus(new AbortController());
  let execution: PreparedCoderExecution | undefined;
  const config: NativeCoderDevelopmentConfig = { mode: 'test', context: f.context,
    packageDirectory: resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
    anchorPath: resolve('dist/apps/electron/native-agent-runtime-integrity.json'),
    sessionRoot: join(f.directory, 'native-sessions'), workspaceRoot: root,
    workspaceLeaseRoot: join(f.directory, 'native-workspace-leases') };
  main.handle('native.authority', payload => dispatchNativeAuthority({ authority: f.store, context: f.context,
    operation: (payload as { operation: NativeAuthorityOperation }).operation, assertOwner() {} }));
  try {
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 10_000 });
    git(['init', '--initial-branch=main']);
    git(['config', 'core.autocrlf', 'false']);
    await writeFile(join(root, 'seed.txt'), 'original\n');
    git(['add', 'seed.txt']);
    git(['-c', 'user.name=Harness', '-c', 'user.email=harness@example.invalid', 'commit', '-m', 'fixture']);
    let persisted = '';
    const worktree = await prepareNativeCoderWorkspace({ projectRoot: root,
      requested: { name: 'isolated', branch: 'codex/native-worktree-test' }, signal: bus.ctrl.signal,
      persist: async path => { persisted = path; await f.sessions.setSessionWorktree(f.context.sessionId, path); } },
    config, worker, 1, () => {});
    expect(persisted).toBe(worktree);
    expect(await readFile(join(worktree, 'seed.txt'), 'utf8')).toBe('original\n');
    expect(await prepareNativeCoderWorkspace({ projectRoot: root, existingPath: worktree,
      persist: async () => { throw new Error('Existing tree must not be recreated'); } }, config, worker, 1, () => {})).toBe(worktree);
    await expect(verifyNativeCoderWorkspace(config, { kind: 'worktree', cwd: root }, bus.ctrl.signal))
      .rejects.toThrow('outside its managed');
    await expect(verifyNativeCoderWorkspace(config, { kind: 'worktree', cwd: join(root, '.mcp-indexer/worktrees/missing') }, bus.ctrl.signal))
      .rejects.toThrow();
    const foreign = join(root, '.mcp-indexer/worktrees/foreign');
    await mkdir(foreign);
    execFileSync('git', ['init', '--initial-branch=main', foreign], { cwd: root, windowsHide: true, timeout: 10_000 });
    await expect(verifyNativeCoderWorkspace(config, { kind: 'worktree', cwd: foreign }, bus.ctrl.signal))
      .rejects.toThrow('not registered');
    const cancelled = new AbortController();
    cancelled.abort(new Error('cancel before Git'));
    await expect(prepareNativeCoderWorkspace({ projectRoot: root, requested: { name: 'cancelled' }, signal: cancelled.signal,
      persist: async () => { throw new Error('Cancelled preparation must not persist'); } }, config, worker, 1, () => {}))
      .rejects.toThrow('cancel before Git');
    expect(existsSync(join(root, '.mcp-indexer/worktrees/cancelled'))).toBe(false);
    const preserved = join(root, '.mcp-indexer/worktrees/persist-failed');
    await expect(prepareNativeCoderWorkspace({ projectRoot: root, requested: { name: 'persist-failed' },
      persist: async () => { throw new Error('fixture persistence failure'); } }, config, worker, 1, () => {}))
      .rejects.toThrow('fixture persistence failure');
    expect(await readFile(join(preserved, 'seed.txt'), 'utf8')).toBe('original\n');
    expect(await verifyNativeCoderWorkspace(config, { kind: 'worktree', cwd: preserved }, bus.ctrl.signal)).toBe(preserved);
    expect(JSON.parse(await readFile(join(config.workspaceLeaseRoot, 'leases.json'), 'utf8')).state.leases).toEqual([]);
    const registry = new ToolRegistry();
    for (const name of ['create_file', 'read_file']) registry.register(fsTools.find(tool => tool.name === name)!);
    registry.seal();
    const systemPrompt = 'Create and read only in the selected worktree.';
    const preparation = prepareCoderAttempt({ sessionId: f.context.sessionId, agentRunId: f.context.agentRunId,
      runnerRunId: 'native-worktree', provider: 'openai', model: 'fixture', agentDefinitionId: 'coder', capabilityProfile: 'full',
      systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'), environment: { kind: 'worktree', cwd: worktree },
      policy: { permissionMode: 'auto', planMode: false, specMode: false } }, registry);
    let calls = 0;
    execution = await executeNativeCoder({ bridge: worker, runId: 1, bus, assertOwner() {}, config,
      prepared: { preparation, registry, systemPrompt, thinking: false, maxTurns: 3,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Create a marker inside the isolated worktree.' }] }],
        toolContext: { cwd: worktree, projectName: 'worktree-fixture', signal: bus.ctrl.signal }, signal: bus.ctrl.signal,
        provider: { name: 'openai', model: 'fixture', setModel() {}, async *chat(request) {
          if (++calls === 1) {
            for (const tool of [{ id: 'create', name: 'create_file', input: { path: 'marker.txt', content: 'isolated' } },
              { id: 'read', name: 'read_file', input: { path: 'marker.txt' } }]) {
              yield { type: 'tool_call_start', id: tool.id, name: tool.name };
              yield { type: 'tool_call_end', ...tool };
            }
          } else {
            expect(JSON.stringify(request.messages)).toContain('isolated');
            yield { type: 'text_delta', text: 'Worktree complete.' };
          }
          yield { type: 'done' };
        } },
      } });
    expect((await execution.done).reason).toBe('completed');
    expect(calls).toBe(2);
    expect(await readFile(join(worktree, 'marker.txt'), 'utf8')).toBe('isolated');
    expect(existsSync(join(root, 'marker.txt'))).toBe(false);
    expect(git(['branch', '--show-current']).trim()).toBe('main');
    expect(JSON.parse(await readFile(join(config.workspaceLeaseRoot, 'leases.json'), 'utf8')).state.leases).toEqual([]);
  } finally {
    bus.ctrl.abort();
    if (execution) { await execution.cancel({ code: 'test_cleanup' }).catch(() => undefined); await execution.done.catch(() => undefined); }
    main.dispose(); worker.dispose(); ports.port1.close(); ports.port2.close();
    await f.sessions.close(); await rm(f.directory, { recursive: true, force: true });
  }
}, 60_000);
