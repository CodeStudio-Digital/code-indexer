import { clone } from '@bufbuild/protobuf';
import { agentV1SessionStore } from '@mcp/agent-runtime-contracts';

/** Completion becomes visible only after durable commit AND the Data ACK. */
export class NativeEngineCompletion {
  private resolve!: (record: agentV1SessionStore.EngineEventRecordV1) => void;
  private reject!: (cause: unknown) => void;
  readonly settled = new Promise<agentV1SessionStore.EngineEventRecordV1>((resolve, reject) => {
    this.resolve = resolve; this.reject = reject;
  });
  constructor() { void this.settled.catch(() => undefined); }
  acknowledge(record: agentV1SessionStore.EngineEventRecordV1): void {
    if (record.body.case === 'terminal') this.resolve(clone(agentV1SessionStore.EngineEventRecordV1Schema, record));
  }
  close(): void { this.reject(new Error('native attempt closed before terminal acknowledgement')); }
}
