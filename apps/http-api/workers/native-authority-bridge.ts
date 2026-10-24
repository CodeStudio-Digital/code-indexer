import type { MessageBridge } from '../../../packages/orchestrator-host/src/index.js';
import type { ControlPlaneRunContext } from '../../../packages/store/src/control-plane/index.js';
import type { NativeProductAuthority } from '../native-attempt-runtime.js';
import type { NativeAttemptPreparationInput } from '../native-attempt-preparation.js';
import type { NativeChildRequest } from '../native-child-admission.js';
import type { FileControlPlaneAuthority } from '../file-control-plane-store.js';
import type { NativeInboxSource } from '../native-tree-inbox.js';
import type { PreparedDurabilityFacts, RuntimeRouteRecord, SupervisorFactBinding,
  SupervisorLifecycleFact } from '../../../packages/agent-runtime-host/src/index.js';

export type NativeAuthorityOperation =
  | { kind: 'state'; requireActiveLease: boolean }
  | { kind: 'spawnChild'; request: NativeChildRequest }
  | { kind: 'childTranscript'; reference: string }
  | { kind: 'childCompletion'; reference: string }
  | { kind: 'continuationInbox'; source: NativeInboxSource }
  | { kind: 'admit'; input: NativeAttemptPreparationInput }
  | { kind: 'activate'; nonce: Uint8Array; facts: PreparedDurabilityFacts; deadlineAtUnixMs: bigint }
  | { kind: 'fact'; connectionId: string; fact: SupervisorLifecycleFact; binding: SupervisorFactBinding;
      deadlineAtUnixMs: bigint; idempotencyKey: string }
  | { kind: 'getRoute' }
  | { kind: 'route'; route: RuntimeRouteRecord }
  | { kind: 'request'; key: string; payload: unknown }
  | { kind: 'terminal'; input: Parameters<NativeProductAuthority['terminalizeRun']>[0] };

/** Only this worker's accepted run is addressable. Authority stays in main;
 * the provider and capability gateways stay in the worker realm. */
export function workerNativeAuthority(bridge: MessageBridge, runId: number, context: ControlPlaneRunContext): NativeProductAuthority {
  const call = <T>(operation: NativeAuthorityOperation): Promise<T> =>
    bridge.request('native.authority', { runId, agentRunId: context.agentRunId, operation }, { timeoutMs: 30_000 });
  const assertContext = (candidate: ControlPlaneRunContext) => {
    for (const key of Object.keys(context) as (keyof ControlPlaneRunContext)[]) {
      if (candidate[key] !== context[key]) throw new Error('Native worker attempted to change its control-plane identity');
    }
  };
  return {
    admitNativeChild(candidate, request) { assertContext(candidate); return call({ kind: 'spawnChild', request }); },
    getAttemptState(candidate, requireActiveLease = true) { assertContext(candidate); return call({ kind: 'state', requireActiveLease }); },
    admitNativeAttempt(candidate, input) { assertContext(candidate); return call({ kind: 'admit', input }); },
    createNativeActivationPort(candidate, nonce) {
      assertContext(candidate);
      // Preparation scrubs its caller-owned nonce immediately after provisioning.
      // Keep the activation port's copy alive until the runner sends prepared.
      const activationNonce = Uint8Array.from(nonce);
      return { async commitPrepared(facts, control) {
        control.signal.throwIfAborted();
        const receipt = await call<Awaited<ReturnType<ReturnType<NativeProductAuthority['createNativeActivationPort']>['commitPrepared']>>>({
          kind: 'activate', nonce: activationNonce, facts, deadlineAtUnixMs: control.deadlineAtUnixMs });
        control.signal.throwIfAborted(); return receipt;
      } };
    },
    createSupervisorFactPort(candidate, connectionId) {
      assertContext(candidate);
      return { async commit(fact, binding, control) {
        control.signal.throwIfAborted();
        await call({ kind: 'fact', connectionId, fact, binding,
          deadlineAtUnixMs: control.deadlineAtUnixMs, idempotencyKey: control.idempotencyKey });
        control.signal.throwIfAborted();
      } };
    },
    getRuntimeRoute(sessionId, attemptId) {
      if (sessionId !== context.sessionId || attemptId !== context.attemptId) throw new Error('Native route scope changed');
      return call({ kind: 'getRoute' });
    },
    commitRuntimeRoute(candidate, route) { assertContext(candidate); return call({ kind: 'route', route }); },
    commitRuntimeRequest(candidate, key, payload) { assertContext(candidate); return call({ kind: 'request', key, payload }); },
    terminalizeRun(input) { assertContext(input.context); return call({ kind: 'terminal', input }); },
  };
}

/** Receiver closes over main-owned context; no RPC can supply another owner. */
export async function dispatchNativeAuthority(input: {
  authority: NativeProductAuthority & Partial<Pick<FileControlPlaneAuthority, 'resolveNativeChild' | 'resolveNativeChildTranscript' | 'resolveNativeChildCompletion' | 'readNativeContinuationInbox'>>;
  context: ControlPlaneRunContext;
  agentRunId?: string;
  operation: NativeAuthorityOperation;
  assertOwner(): void;
}) {
  const { authority, operation, assertOwner } = input;
  let context = input.context;
  assertOwner();
  if (input.agentRunId !== undefined && input.agentRunId !== context.agentRunId) {
    const cleanup = operation.kind === 'terminal' || operation.kind === 'getRoute'
      || operation.kind === 'state' && !operation.requireActiveLease
      || operation.kind === 'request' && operation.key === 'cancel'
      || operation.kind === 'fact' && ['attemptProcessExited', 'attemptProcessReaped'].includes(operation.fact.case);
    if (!authority.resolveNativeChild) throw new Error('Native child routing is unavailable');
    context = await authority.resolveNativeChild(context, input.agentRunId, !cleanup);
    assertOwner();
  }
  const control = (deadlineAtUnixMs: bigint) => {
    const remaining = Number(deadlineAtUnixMs - BigInt(Date.now()));
    if (!Number.isSafeInteger(remaining) || remaining <= 0) throw new Error('Native authority RPC deadline is invalid');
    return { deadlineAtUnixMs, signal: AbortSignal.timeout(Math.min(remaining, 30_000)) };
  };
  let result: unknown;
  switch (operation.kind) {
    case 'continuationInbox': {
      if (!authority.readNativeContinuationInbox) throw new Error('Native continuation inbox authority is unavailable');
      result = await authority.readNativeContinuationInbox(context, operation.source); break;
    }
    case 'childCompletion': {
      if (!authority.resolveNativeChildCompletion) throw new Error('Native child completion authority is unavailable');
      result = await authority.resolveNativeChildCompletion(context, operation.reference); break;
    }
    case 'childTranscript': {
      if (!authority.resolveNativeChildTranscript) throw new Error('Native child transcript authority is unavailable');
      result = await authority.resolveNativeChildTranscript(context, operation.reference); break;
    }
    case 'spawnChild': result = await authority.admitNativeChild(context, operation.request); break;
    case 'state': result = await authority.getAttemptState(context, operation.requireActiveLease); break;
    case 'admit': result = await authority.admitNativeAttempt(context, operation.input); break;
    case 'activate': result = await authority.createNativeActivationPort(context, operation.nonce)
      .commitPrepared(operation.facts, control(operation.deadlineAtUnixMs)); break;
    case 'fact': result = await authority.createSupervisorFactPort(context, operation.connectionId)
      .commit(operation.fact, operation.binding, { ...control(operation.deadlineAtUnixMs), idempotencyKey: operation.idempotencyKey }); break;
    case 'getRoute': result = await authority.getRuntimeRoute(context.sessionId, context.attemptId); break;
    case 'route': result = await authority.commitRuntimeRoute(context, operation.route); break;
    case 'request': result = await authority.commitRuntimeRequest(context, operation.key, operation.payload); break;
    case 'terminal': result = await authority.terminalizeRun({ ...operation.input, context }); break;
    default: throw new Error('Unsupported native authority operation');
  }
  assertOwner(); return result;
}
