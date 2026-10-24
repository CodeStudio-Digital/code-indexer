import { createHash, timingSafeEqual } from 'node:crypto';
import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { agentV1Runtime as wire } from '@mcp/agent-runtime-contracts';
import { attemptIdentityEqual } from './FrameHeaderValidation.js';
import type { HostDataBoundContext } from './HostDataAttemptChannelValidation.js';
import { HostDataChannelError } from './HostDataChannelError.js';

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_CHUNK_BYTES = 128 * 1024;
type Coordinates = wire.ProviderRequestCommit | wire.ProviderRequestChunk;

/** One bounded transfer per authenticated attempt. No provider or store call
 * is authorized until the complete canonical request and its hash validate. */
export class ProviderRequestTransfer {
  #pending?: { operationId: string; digest: Uint8Array; checkpointOnly: boolean;
    bytes: Uint8Array; offset: number; deadline: bigint };
  constructor(private readonly context: HostDataBoundContext) {}
  get pending(): boolean { return !!this.#pending; }

  append(chunk: wire.ProviderRequestChunk, deadline: bigint | undefined): void {
    this.#validate(chunk, deadline);
    if (!chunk.encodedChunk.length || chunk.encodedChunk.length > MAX_CHUNK_BYTES
      || chunk.chunkOffset < 0n || chunk.chunkOffset + BigInt(chunk.encodedChunk.length) > chunk.totalBytes) {
      throw failure('provider request chunk bounds diverged');
    }
    if (!this.#pending) {
      if (chunk.chunkOffset !== 0n) throw failure('provider request transfer must start at zero');
      this.#pending = { operationId: chunk.operationId, digest: Uint8Array.from(chunk.requestSha256),
        checkpointOnly: chunk.checkpointOnly, bytes: new Uint8Array(Number(chunk.totalBytes)), offset: 0, deadline: deadline! };
    }
    const state = this.#match(chunk, deadline!);
    if (chunk.chunkOffset !== BigInt(state.offset)) throw failure('provider request chunk is not contiguous');
    state.bytes.set(chunk.encodedChunk, state.offset);
    state.offset += chunk.encodedChunk.length;
  }

  finish(commit: wire.ProviderRequestCommit, deadline: bigint | undefined): wire.ProviderStart {
    this.#validate(commit, deadline);
    const state = this.#match(commit, deadline!);
    try {
      if (state.offset !== state.bytes.length || !sameDigest(createHash('sha256').update(state.bytes).digest(), state.digest)) {
        throw failure('provider request transfer is incomplete or corrupt');
      }
      // Protobuf byte fields borrow their input. Give the returned request an
      // independent backing buffer before clearing transfer ownership.
      const start = fromBinary(wire.ProviderStartSchema, state.bytes.slice());
      if (!start.identity || !attemptIdentityEqual(start.identity, this.context.identity)
        || start.operationId !== state.operationId || start.deadlineAtUnixMs !== state.deadline
        || !Buffer.from(toBinary(wire.ProviderStartSchema, start)).equals(state.bytes)) {
        throw failure('provider request transfer authority or encoding diverged');
      }
      return start;
    } finally { this.clear(); }
  }

  clear(): void { this.#pending?.bytes.fill(0); this.#pending = undefined; }

  #validate(value: Coordinates, deadline: bigint | undefined): void {
    if (!value.identity || !attemptIdentityEqual(value.identity, this.context.identity)
      || value.runtimeInstanceId !== this.context.runtimeInstanceId || !value.operationId
      || Buffer.byteLength(value.operationId) > 256 || value.totalBytes < 1n
      || value.totalBytes > BigInt(MAX_REQUEST_BYTES) || value.requestSha256.length !== 32
      || deadline === undefined || deadline <= 0n) throw failure('provider request transfer bounds or authority invalid');
  }
  #match(value: Coordinates, deadline: bigint) {
    const state = this.#pending;
    if (!state || state.operationId !== value.operationId || state.checkpointOnly !== value.checkpointOnly
      || state.bytes.length !== Number(value.totalBytes) || state.deadline !== deadline
      || !sameDigest(state.digest, value.requestSha256)) throw failure('provider request transfer changed ownership');
    return state;
  }
}
function sameDigest(a: Uint8Array, b: Uint8Array): boolean { return a.length === 32 && b.length === 32 && timingSafeEqual(a, b); }
function failure(message: string) { return new HostDataChannelError('provider_failure', message); }
