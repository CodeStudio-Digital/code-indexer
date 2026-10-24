import { createHash } from 'node:crypto';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { agentV1Artifact as artifact, agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';
import { NativeSessionAttachments } from './NativeSessionAttachments.js';
import type { EngineEventRecoveryStorePort } from './NativeEngineEventRecovery.js';
import type { NativeRustHostAttemptRuntime } from './NativeRustHostAttemptRuntime.js';

interface Reader { store: EngineEventRecoveryStorePort; close(): Promise<void> }
interface Options {
  sessionId: string;
  signal: AbortSignal;
  assertOwner(): void;
  commit: NativeRustHostAttemptRuntime['commitAttachment'];
  openReader(): Promise<Reader>;
  maximumBytes?: number;
}
const digest = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');
const outputName = (id: string) => `tool-output-${id}.txt`;

/** Bounded hot cache; all durable bytes belong to the authorized Rust writer.
 * Recovery indexes one immutable snapshot lazily, only on an explicit read. */
export class NativeToolOutputStore {
  private readonly cache = new Map<string, string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly index = new Map<string, wire.CommitSessionRecordReceipt[]>();
  private reader?: Promise<Reader>;
  private indexed?: Promise<void>;
  private failure: unknown;
  private used = 0;
  private closed = false;
  private readonly maximumBytes: number;
  constructor(private readonly options: Options) {
    this.maximumBytes = options.maximumBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maximumBytes) || this.maximumBytes < 1 || this.maximumBytes > 8 * 1024 * 1024) throw new Error('Invalid output cache budget');
  }
  private assertOpen(signal?: AbortSignal): void {
    signal?.throwIfAborted(); this.options.signal.throwIfAborted(); this.options.assertOwner();
    if (this.closed) throw new Error('Native output store closed');
    if (this.failure) throw this.failure;
  }
  put(content: string): string | null {
    this.assertOpen();
    const id = digest(content);
    if (this.cache.has(id)) return id;
    const bytes = Buffer.byteLength(content);
    if (!bytes || this.cache.size >= 256 || this.used + bytes > this.maximumBytes) return null;
    this.used += bytes; this.cache.set(id, content);
    const write = this.persist(id, content).catch(error => { this.failure = error; throw error; })
      .finally(() => this.pending.delete(write));
    this.pending.add(write); void write.catch(() => undefined);
    return id;
  }
  private async persist(id: string, content: string): Promise<void> {
    const bytes = Buffer.from(content), identity = createHash('sha256')
      .update(`codestudio.native-tool-output.v1\0${this.options.sessionId}\0${id}`).digest().subarray(0, 16);
    identity[6] = (identity[6]! & 15) | 0x50; identity[8] = (identity[8]! & 63) | 0x80;
    const hex = identity.toString('hex');
    const reference = create(artifact.ArtifactRefSchema, {
      artifactId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
      kind: 'document', ownerSessionId: this.options.sessionId, contentSha256: Buffer.from(id, 'hex'),
      byteLength: BigInt(bytes.length), displayName: outputName(id), mediaType: 'text/plain; charset=utf-8',
      compression: artifact.ArtifactCompression.NONE, privacyClass: artifact.ArtifactPrivacyClass.CONFIDENTIAL,
      redactionPolicyVersion: 'native-tool-output-v1',
    });
    const encodedReference = Buffer.from(toBinary(artifact.ArtifactRefSchema, reference));
    try {
      this.assertOpen();
      await this.options.commit(reference, { read: (requested, maximum, signal) => {
        this.assertOpen(signal);
        if (bytes.length > maximum || !encodedReference.equals(toBinary(artifact.ArtifactRefSchema, requested))) throw new Error('Native output reference diverged');
        return bytes.slice();
      } }, this.options.signal);
      this.assertOpen();
    } finally { bytes.fill(0); }
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
    if (this.failure) throw this.failure;
  }
  hasOutputs(): boolean { return this.cache.size > 0 || this.index.size > 0; }
  async get(id: string, signal?: AbortSignal): Promise<string | null> {
    this.assertOpen(signal);
    if (!/^[a-f0-9]{64}$/.test(id)) return null;
    const cached = this.cache.get(id);
    if (cached !== undefined) { await this.drain(); this.assertOpen(signal); return cached; }
    this.indexed ??= this.loadIndex();
    await this.indexed; this.assertOpen(signal);
    const receipts = this.index.get(id); if (!receipts) return null;
    const reader = await this.reader!, attachments = new NativeSessionAttachments(this.options.sessionId, { includeToolOutputs: true });
    try {
      let reference: wire.SessionAttachmentChunkV1['reference'];
      for (const receipt of receipts) {
        this.assertOpen(signal);
        const payload = await reader.store.read(receipt);
        this.assertOpen(signal);
        attachments.append(receipt, payload);
        reference = fromBinary(wire.SessionAttachmentChunkV1Schema, payload).reference;
      }
      if (!reference) throw new Error('Native output lacks a committed reference');
      const bytes = attachments.read(reference, this.maximumBytes, this.options.signal);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (digest(content) !== id) throw new Error('Native output recovery digest diverged');
      this.assertOpen(signal);
      if (this.used + bytes.length <= this.maximumBytes && this.cache.size < 256) {
        this.cache.set(id, content); this.used += bytes.length;
      }
      return content;
    } finally { attachments.close(); }
  }
  private async loadIndex(): Promise<void> {
    this.assertOpen(); this.reader ??= this.options.openReader();
    const reader = await this.reader;
    let cursor = 0n, count = 0;
    for (;;) {
      this.assertOpen();
      const page = await reader.store.list(cursor, Math.min(256, 100_000 - count));
      if (!page.records.length && !page.complete) throw new Error('Native output snapshot did not advance');
      for (const receipt of page.records) {
        this.assertOpen();
        if (++count > 100_000 || receipt.sessionId !== this.options.sessionId || receipt.globalSequence <= cursor) throw new Error('Native output snapshot diverged');
        cursor = receipt.globalSequence;
        if (receipt.kind !== wire.SessionRecordKind.ATTACHMENT) continue;
        const payload = await reader.store.read(receipt);
        if (receipt.payloadBytes !== BigInt(payload.length) || !createHash('sha256').update(payload).digest().equals(receipt.payloadSha256)) throw new Error('Native output receipt diverged');
        const chunk = fromBinary(wire.SessionAttachmentChunkV1Schema, payload), reference = chunk.reference;
        const id = reference?.redactionPolicyVersion === 'native-tool-output-v1'
          ? reference.displayName.match(/^tool-output-([a-f0-9]{64})\.txt$/)?.[1] : undefined;
        if (!id) continue;
        if (reference!.ownerSessionId !== this.options.sessionId || reference!.byteLength > BigInt(this.maximumBytes)) throw new Error('Native output ownership or budget diverged');
        const receipts = this.index.get(id) ?? [];
        receipts.push(receipt); this.index.set(id, receipts);
      }
      if (page.nextGlobalSequence !== cursor || (!page.complete && count === 100_000)) throw new Error('Native output snapshot cursor exceeded bounds');
      if (page.complete) return;
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.pending]);
    try { if (this.reader) await (await this.reader).close(); }
    finally { this.cache.clear(); this.index.clear(); this.used = 0; }
  }
}
