import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { expect, it, vi } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import { prepareCoderAttempt } from '@mcp/code-agent/runtime/attempt-preparation.js';
import type { ChatProvider } from '@mcp/provider-sdk/adapter.js';
import { NativeRustHostAttemptRuntime } from '../../../packages/agent-runtime-host/src/native/NativeRustHostAttemptRuntime.js';
import { NativeTreeResources } from '../workers/native-tree-resources.js';
import { executeNativeCoder } from '../workers/native-coder-execution.js';
import { dispatchNativeAuthority, type NativeAuthorityOperation } from '../workers/native-authority-bridge.js';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';
import { createBus } from '../coder-bus.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;

physicalIt.each(['exception', 'cancelled'] as const)('releases the product workspace lease and retains zero process reservations after preparation is %s', async fault => {
  const fixture = await supervisorFactFixture('coder', 120_000), channels = new MessageChannel();
  const main = new MessageBridge({ port: channels.port1 }), worker = new MessageBridge({ port: channels.port2 });
  const bus = createBus(new AbortController()), root = join(fixture.directory, 'project'), leaseRoot = join(fixture.directory, 'leases');
  const sharedLeaseRoot = join(fixture.directory, 'shared-leases'), cause = new Error(`product preparation ${fault}`);
  main.handle('native.authority', payload => {
    const packet = payload as { agentRunId: string; operation: NativeAuthorityOperation };
    return dispatchNativeAuthority({ authority: fixture.store, context: fixture.context, ...packet, assertOwner() {} });
  });
  let resources: NativeTreeResources | undefined, reserveRuntime: ReturnType<typeof vi.fn<() => () => void>> | undefined;
  let openedStore = false, spawned = 0, providerCalls = 0;
  const bind = NativeTreeResources.prototype.bind, createRuntime = NativeRustHostAttemptRuntime.create;
  const bindSpy = vi.spyOn(NativeTreeResources.prototype, 'bind').mockImplementation(function(this: NativeTreeResources, binding) {
    resources = this; const bound = bind.call(this, binding); reserveRuntime = vi.fn(bound.reserveRuntime);
    return { ...bound, reserveRuntime };
  });
  const runtimeSpy = vi.spyOn(NativeRustHostAttemptRuntime, 'create').mockImplementation((options, signal) => createRuntime.call(NativeRustHostAttemptRuntime, {
    ...options, binding: { ...options.binding, async openHostSupervisorBridge(bytes) {
      spawned++; return options.binding.openHostSupervisorBridge(bytes);
    } },
    sessionStoreReady: async store => {
      openedStore = true;
      await options.sessionStoreReady?.(store);
      if (fault === 'cancelled') { bus.ctrl.abort(cause); return; }
      throw cause;
    },
  }, signal));
  const provider: ChatProvider = { name: 'openai', model: 'fixture', setModel() {}, async *chat() {
    providerCalls++; yield { type: 'done' };
  } };
  let execution: Awaited<ReturnType<typeof executeNativeCoder>> | undefined;
  try {
    const registry = new ToolRegistry(); registry.register(fsTools.find(tool => tool.name === 'read_file')!); registry.seal();
    const systemPrompt = 'Read the owned project.';
    const preparation = prepareCoderAttempt({ sessionId: fixture.context.sessionId, agentRunId: fixture.context.agentRunId,
      runnerRunId: randomUUID(), provider: 'openai', model: 'fixture', agentDefinitionId: 'coder', capabilityProfile: 'full',
      systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'), environment: { kind: 'host', cwd: root },
      policy: { permissionMode: 'auto', planMode: false, specMode: false } }, registry);
    const attempt = executeNativeCoder({ bridge: worker, runId: 1, bus, assertOwner() {},
      config: { mode: 'test', context: fixture.context, packageDirectory: resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
        anchorPath: resolve('dist/apps/electron/native-agent-runtime-integrity.json'), sessionRoot: join(fixture.directory, 'native-sessions'),
        workspaceRoot: root, workspaceLeaseRoot: leaseRoot, sharedWorkspaceLeaseRoot: sharedLeaseRoot },
      prepared: { preparation, registry, provider, systemPrompt, thinking: false, maxTurns: 1,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Read project.' }] }],
        toolContext: { cwd: root, projectName: 'preparation-cleanup', sessionId: fixture.context.sessionId } },
    }).then(value => { execution = value; return value; });
    await expect(attempt).rejects.toThrow(cause.message);
    expect(openedStore).toBe(true); expect(spawned).toBe(0); expect(providerCalls).toBe(0);
    expect(reserveRuntime).not.toHaveBeenCalled();
    expect(resources?.snapshot()).toEqual({ memoryBytes: 0, processes: 0, groups: 0 });
    for (const directory of [leaseRoot, sharedLeaseRoot]) {
      expect(JSON.parse(await readFile(join(directory, 'leases.json'), 'utf8')).state.leases).toEqual([]);
    }
  } finally {
    bindSpy.mockRestore(); runtimeSpy.mockRestore(); bus.ctrl.abort();
    await execution?.cancel().catch(() => undefined); await execution?.done.catch(() => undefined);
    main.dispose(); worker.dispose(); channels.port1.close(); channels.port2.close();
    await fixture.sessions.close(); await rm(fixture.directory, { recursive: true, force: true });
  }
}, 60_000);
