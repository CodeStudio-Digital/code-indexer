/** AttachmentStore over R2 (the `ASSETS` bucket). Keys are server-generated. */
import type { AttachmentStore } from '@cloudstudio/cloud-feedback';

export function createAttachmentStore(bucket: R2Bucket): AttachmentStore {
  return {
    async put(key, body, meta) {
      await bucket.put(key, body, { httpMetadata: { contentType: meta.contentType } });
    },
  };
}
