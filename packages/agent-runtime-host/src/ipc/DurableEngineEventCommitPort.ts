import type {
  agentV1Common,
  agentV1SessionStore,
} from '@mcp/agent-runtime-contracts';

export interface DurableEngineEventCommitRequest {
  readonly identity: agentV1Common.AttemptIdentity;
  readonly runtimeInstanceId: string;
  readonly record: agentV1SessionStore.EngineEventRecordV1;
  readonly expectedPayloadSha256: Uint8Array;
}

/** Host-owned durability boundary. Implementations must commit through the
 * native fenced session writer and resolve only after the filesystem receipt. */
export interface DurableEngineEventCommitPort {
  commit(
    request: DurableEngineEventCommitRequest,
  ): Promise<agentV1SessionStore.CommitSessionRecordReceipt>;
}
