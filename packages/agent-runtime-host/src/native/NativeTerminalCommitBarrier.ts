import type { agentV1SessionStore } from '@mcp/agent-runtime-contracts';
import type { DurableEngineEventCommitPort } from '../ipc/DurableEngineEventCommitPort.js';

export type NativeTerminalCommitBarrier = (record: agentV1SessionStore.EngineEventRecordV1) => Promise<void>;

/** The parent writer may not publish its terminal while owned background
 * children still consume its authority. A replay observes the same settlement
 * promise, including failure; it cannot restart any work. */
export function withNativeTerminalCommitBarrier(port: DurableEngineEventCommitPort,
  settle?: NativeTerminalCommitBarrier): DurableEngineEventCommitPort {
  if (!settle) return port;
  let terminal: { identity: string; settled: Promise<void> } | undefined;
  return {
    async commit(request) {
      if (request.record.body.case === 'terminal') {
        const identity = `${request.identity.attemptId}:${request.runtimeInstanceId}:${request.record.localSequence}:${Buffer.from(request.expectedPayloadSha256).toString('hex')}`;
        if (terminal && terminal.identity !== identity) throw new Error('Native terminal settlement replay diverged');
        if (!terminal) terminal = { identity, settled: Promise.resolve().then(() => settle(request.record)) };
        await terminal.settled;
      }
      return port.commit(request);
    },
    ...(port.commitProviderFrontier ? { commitProviderFrontier: port.commitProviderFrontier.bind(port) } : {}),
    ...(port.afterEngineEventAcknowledged ? { afterEngineEventAcknowledged: port.afterEngineEventAcknowledged.bind(port) } : {}),
  };
}
