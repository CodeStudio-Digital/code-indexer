import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { NodeJsonLineTransport } from './NodeJsonLineTransport.js';
import type {
  OssEngineProcessFinalization,
  OssEngineProcessLaunchRequest,
  OssEngineProcessLease,
  OssEngineProcessSupervisorPort,
} from './SupervisionTypes.js';
import { OssEngineSupervisionError } from './SupervisionValidation.js';

const DIRECT_EXIT_GRACE_MS = 2_000;

/**
 * Diagnostic-only process launcher.
 *
 * It deliberately reports `direct_process` and can never produce tree-reap or
 * aggregate-limit evidence. Production certification therefore stays closed.
 */
export class DirectOssEngineProcessSupervisor implements OssEngineProcessSupervisorPort {
  async launch(
    request: OssEngineProcessLaunchRequest,
    signal: AbortSignal,
  ): Promise<OssEngineProcessLease> {
    signal.throwIfAborted();
    const child = spawn(request.executable, [...request.arguments], {
      cwd: request.workingDirectory,
      env: { ...request.environment },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const exit = processExit(child);
    try {
      await waitForSpawn(child, signal);
    } catch (cause) {
      child.kill();
      throw new OssEngineSupervisionError(
        'direct_process_spawn_failed',
        'Direct diagnostic candidate process failed to spawn',
        cause,
      );
    }
    if (!child.pid) {
      child.kill();
      throw new OssEngineSupervisionError(
        'direct_process_id_missing',
        'Direct diagnostic candidate has no process ID',
      );
    }
    child.stderr.resume();
    const transport = new NodeJsonLineTransport(child.stdout, child.stdin, {
      maxLineBytes: 1024 * 1024,
      endWritableOnClose: true,
    });
    const launchReceipt = Object.freeze({
      candidate: request.candidate,
      candidateVersion: request.candidateVersion,
      protocolVersion: request.protocolVersion,
      protocolSchemaDigest: request.protocolSchemaDigest,
      attemptId: request.attemptId,
      source: 'direct_process' as const,
      resourceGroupId: `direct:${child.pid}`,
      processId: child.pid,
      containmentLevel: 'unavailable' as const,
      processTreeOwned: false,
      enforcedLimits: [],
      spawnedAt: new Date().toISOString(),
    });
    let finalization: Promise<OssEngineProcessFinalization> | undefined;
    return Object.freeze({
      launchReceipt,
      transport,
      finalize: (input: Parameters<OssEngineProcessLease['finalize']>[0]) => {
        finalization ??= finalizeDirectProcess(child, exit, transport, input);
        return finalization;
      },
    });
  }
}

async function finalizeDirectProcess(
  child: ChildProcessWithoutNullStreams,
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  transport: NodeJsonLineTransport,
  input: Parameters<OssEngineProcessLease['finalize']>[0],
): Promise<OssEngineProcessFinalization> {
  await transport.close().catch(() => undefined);
  const remaining = Number(input.deadlineAtUnixMs - BigInt(Date.now()));
  const firstWaitMs = Math.max(0, Math.min(DIRECT_EXIT_GRACE_MS, remaining));
  let observedExit = await withTimeout(exit, firstWaitMs);
  if (!observedExit) {
    child.kill();
    observedExit = await withTimeout(exit, DIRECT_EXIT_GRACE_MS);
  }
  return Object.freeze({
    status: 'ownership_retained',
    disposition: input.disposition,
    reason: observedExit
      ? `direct_process_tree_unproven:root_exit=${observedExit.code ?? observedExit.signal ?? 'unknown'}`
      : 'direct_process_tree_unproven:root_exit_not_observed',
  });
}

function processExit(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once('error', () => resolve({ code: null, signal: null }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function waitForSpawn(
  child: ChildProcessWithoutNullStreams,
  signal: AbortSignal,
): Promise<void> {
  if (child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      detach();
      reject(signal.reason instanceof Error ? signal.reason : new Error('Spawn aborted'));
    };
    const onSpawn = () => {
      detach();
      resolve();
    };
    const onError = (cause: Error) => {
      detach();
      reject(cause);
    };
    const detach = () => {
      signal.removeEventListener('abort', onAbort);
      child.removeListener('spawn', onSpawn);
      child.removeListener('error', onError);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  if (timeoutMs <= 0) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve(undefined), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timeout);
        reject(cause);
      },
    );
  });
}
