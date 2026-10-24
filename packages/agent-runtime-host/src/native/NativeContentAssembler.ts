import { createHash, type Hash } from 'node:crypto';
import { agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';
import { validateEngineContent } from '../ipc/EngineContentRecord.js';

/** Runner commits chunks contiguously. Partial groups remain invisible across
 * crash/reconnect; replay begins at the group's first record. */
export class NativeContentAssembler {
  private pending?: { key: string; received: bigint; chunks: Uint8Array[]; hash: Hash };

  append(content: wire.EngineContentRecordV1): Uint8Array | undefined {
    validateEngineContent(content);
    const key = JSON.stringify([content.contentId, content.kind, content.operationId,
      content.toolUseId, content.contentSchemaId, content.contentSchemaVersion,
      content.totalBytes.toString(), Buffer.from(content.contentSha256).toString('hex'), content.thinking]);
    if (content.chunkOffset === 0n) {
      if (this.pending) throw new Error('native content group interrupted');
      this.pending = { key, received: 0n, chunks: [], hash: createHash('sha256') };
    }
    const pending = this.pending;
    if (!pending || pending.key !== key || pending.received !== content.chunkOffset) {
      throw new Error('native content chunks are missing or divergent');
    }
    const chunk = Uint8Array.from(content.encodedChunk);
    pending.chunks.push(chunk); pending.hash.update(chunk); pending.received += BigInt(chunk.byteLength);
    if (pending.received !== content.totalBytes) return undefined;
    this.pending = undefined;
    if (pending.hash.digest('hex') !== Buffer.from(content.contentSha256).toString('hex')) {
      throw new Error('native content group hash mismatch');
    }
    return Uint8Array.from(Buffer.concat(pending.chunks));
  }

  assertComplete(): void { if (this.pending) throw new Error('native content group is incomplete'); }
}
