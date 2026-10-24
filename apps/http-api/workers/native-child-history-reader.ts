import { readFile } from 'node:fs/promises';
import type { MessageBridge } from '@mcp/orchestrator-host';
import { parseRuntimePackageAnchor, verifyRuntimePackage } from '@mcp/agent-runtime-host';
import type { ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import type { NativeCoderDevelopmentConfig } from './native-coder-execution.js';
import { readNativeChildTranscript } from '../native-child-transcript.js';

/** Lives in the session worker, including its post-run linger window. Main
 * only resolves ownership; native journal validation and rendering stay here. */
export type NativeChildHistoryConfig = Pick<NativeCoderDevelopmentConfig, 'anchorPath' | 'packageDirectory' | 'sessionRoot'>;
export function createNativeChildHistoryReader(bridge: MessageBridge, runId: number, config: NativeChildHistoryConfig) {
  let active = 0;
  let verified: ReturnType<typeof verifyRuntimePackage> | undefined;
  return async (reference: string, options: { maxChars?: number; signal?: AbortSignal } = {}) => {
    options.signal?.throwIfAborted();
    if (active >= 2) throw new Error('Native child transcript readers are busy');
    active++;
    const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(options.signal ? [options.signal] : [])]);
    try {
      const authorize = () => bridge.request<ControlPlaneRunContext>('native.childTranscript.authorize', { runId, reference }, { timeoutMs: 15_000 });
      const context = await authorize(); signal.throwIfAborted();
      verified ??= readFile(config.anchorPath).then(bytes => verifyRuntimePackage(config.packageDirectory, parseRuntimePackageAnchor(bytes)));
      const runtimePackage = await verified;
      return await readNativeChildTranscript({ context, runtimePackage, rootPath: config.sessionRoot, ...options, signal,
        assertOwner: async () => {
          signal.throwIfAborted();
          if (JSON.stringify(await authorize()) !== JSON.stringify(context)) throw new Error('Native child transcript reader authority changed');
          signal.throwIfAborted();
        } });
    } finally { active--; }
  };
}
