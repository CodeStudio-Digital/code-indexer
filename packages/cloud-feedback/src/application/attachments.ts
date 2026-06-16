/**
 * CreateAttachment — Worker-proxied upload (NOT a presigned PUT), so we sniff the
 * magic bytes and enforce a real size + type allowlist BEFORE the bytes land in
 * R2. The client-declared content-type is ignored; only the sniff is trusted.
 * Keys are server-generated (no path traversal). Attachments require auth.
 */
import { type Result, ok, err, type AccountId, type IdGen, type Clock } from '@cloudstudio/cloud-kernel';
import { type FeedbackError, FeedbackErrors } from '../domain/errors.js';
import type { AttachmentKind } from '../domain/feedback.js';
import type { AttachmentStore, ContentSniffer, FeedbackRepo } from '../domain/ports.js';

const MAX_BYTES: Record<AttachmentKind, number> = {
  image: 5 * 1024 * 1024,
  text: 256 * 1024,
  'diagnostic-json': 64 * 1024,
};
const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'text/plain': 'txt',
  'application/json': 'json',
};

export class CreateAttachmentUseCase {
  constructor(
    private readonly repo: FeedbackRepo,
    private readonly store: AttachmentStore,
    private readonly sniffer: ContentSniffer,
    private readonly ids: IdGen,
    private readonly clock: Clock,
  ) {}

  async execute(input: { accountId: AccountId; bytes: ArrayBuffer }): Promise<Result<{ attachmentId: string; kind: AttachmentKind; contentType: string }, FeedbackError>> {
    if (input.bytes.byteLength === 0) return err(FeedbackErrors.typeRejected('empty'));
    if (input.bytes.byteLength > MAX_BYTES.image) return err(FeedbackErrors.tooLarge(MAX_BYTES.image));

    const sniff = this.sniffer.sniff(new Uint8Array(input.bytes.slice(0, 32)));
    if (!sniff) return err(FeedbackErrors.typeRejected('unknown'));
    if (input.bytes.byteLength > MAX_BYTES[sniff.kind]) return err(FeedbackErrors.tooLarge(MAX_BYTES[sniff.kind]));

    const id = this.ids.uuid();
    const key = `feedback/${input.accountId}/${id}.${EXT[sniff.contentType] ?? 'bin'}`;
    try {
      await this.store.put(key, input.bytes, { contentType: sniff.contentType });
    } catch {
      return err(FeedbackErrors.storage());
    }
    await this.repo.insertAttachment({
      id,
      accountId: input.accountId,
      r2Key: key,
      contentType: sniff.contentType,
      kind: sniff.kind,
      byteSize: input.bytes.byteLength,
      createdAtMs: this.clock.now(),
    });
    return ok({ attachmentId: id, kind: sniff.kind, contentType: sniff.contentType });
  }
}
