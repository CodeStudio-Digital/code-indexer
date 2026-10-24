import { dirname, join, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { mcpRuntimeCoordinationDir } from '@mcp/shared/utils/config.js';
import type { AgentRunHandleApi } from '@mcp/agent-runtime-host';
import type { MessageBridge } from '@mcp/orchestrator-host';
import type { ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import type { NativeProductAuthority } from '../native-attempt-runtime.js';
import type { NativeCoderDevelopmentConfig } from '../workers/native-coder-execution.js';
import type { CoderRunBus } from '../coder-bus.js';
import { bindNativeCoderFacadeContext, coderStreamIdentity, subscribeCoderFacadeEvents } from './coder-facade-events.js';
import { nativeRuntimePaths } from '../native-runtime-paths.js';

export async function nativeCoderDevelopmentConfig(input: { context?: ControlPlaneRunContext; sessionId: string;
  workerFile: string; dbPath: string; projectRoot: string | null }): Promise<NativeCoderDevelopmentConfig | undefined> {
  if (!/^[a-f0-9-]{36}$/i.test(input.sessionId)) throw new Error('Invalid native session identity');
  if (process.env.CODESTUDIO_NATIVE_CODER_DEV !== '1') {
    try { await stat(join(dirname(input.dbPath), 'native-sessions', input.sessionId, 'session.json')); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw cause; }
    throw new Error('This session has a Rust transcript and requires the native runtime to continue');
  }
  if (process.platform !== 'win32' || process.arch !== 'x64' || !input.context || !input.projectRoot) {
    throw new Error('Native coder development requires an admitted Windows x64 project session');
  }
  const distRoot = resolve(dirname(input.workerFile), '../../..');
  return { mode: 'test', context: { ...input.context }, workspaceRoot: input.projectRoot,
    ...nativeRuntimePaths(distRoot),
    sessionRoot: join(dirname(input.dbPath), 'native-sessions'),
    workspaceLeaseRoot: join(dirname(input.dbPath), 'native-workspace-leases'),
    sharedWorkspaceLeaseRoot: join(mcpRuntimeCoordinationDir(), 'native-workspace-leases') };
}

/** The main-process handle addresses the facade in the existing TS gateway
 * worker. Event replay remains on the main bus; no live objects cross RPC. */
export function nativeCoderWorkerHandle(input: {
  context: ControlPlaneRunContext; store: NativeProductAuthority;
  bridge: MessageBridge; bus: CoderRunBus; assertOwner(): void;
}): AgentRunHandleApi {
  const { context, store, bridge, bus } = input;
  bindNativeCoderFacadeContext(bus, context);
  let disposed = false;
  const assertOwner = () => {
    if (disposed) throw new Error('Native coder handle was disposed');
    input.assertOwner();
  };
  return {
    agentRunId: context.agentRunId, attemptId: context.attemptId, runtimeGeneration: 'rust_v1',
    async cancel(reason) {
      assertOwner();
      const result = await bridge.request<{ ok: boolean; reason?: string }>('abort', { reason });
      if (!result.ok) throw new Error(result.reason ?? 'Native cancellation was rejected');
    },
    async resolveInteraction(interactionId, response) {
      assertOwner();
      await bridge.request('native.resolveInteraction', { interactionId, response });
    },
    async getSnapshot() {
      if (disposed) throw new Error('Native coder handle was disposed');
      const state = await store.getAttemptState(context, false);
      const route = await store.getRuntimeRoute(context.sessionId, context.attemptId);
      return { run: state.run, activeAttempt: state.attempt, runtimeGeneration: route?.runtimeGeneration,
        lastGlobalSeq: bus.ended ? bus.nextSeq : bus.nextSeq - 1, stream: coderStreamIdentity(bus) };
    },
    subscribeEvents(cursor) {
      if (disposed) throw new Error('Native coder handle was disposed');
      return subscribeCoderFacadeEvents(bus, context, cursor, 'native');
    },
    dispose() { disposed = true; },
  };
}
