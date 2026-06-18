/**
 * Magic-byte content sniffer. v1 accepts IMAGES ONLY (the screenshot use case):
 * PNG/JPEG/GIF/WEBP. The client-declared Content-Type is ignored — only these
 * signatures pass, which structurally rejects SVG (script vector), HTML, PDF,
 * archives, and renamed-extension polyglots (they don't start with image magic).
 */
import type { ContentSniffer, SniffResult } from '@cloudstudio/cloud-feedback';

export function createContentSniffer(): ContentSniffer {
  return {
    sniff(head: Uint8Array): SniffResult | null {
      if (starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return img('image/png');
      if (starts(head, [0xff, 0xd8, 0xff])) return img('image/jpeg');
      if (starts(head, [0x47, 0x49, 0x46, 0x38])) return img('image/gif');
      if (starts(head, [0x52, 0x49, 0x46, 0x46]) && head.length >= 12 && starts(head.subarray(8), [0x57, 0x45, 0x42, 0x50])) return img('image/webp');
      return null;
    },
  };
}

const img = (contentType: string): SniffResult => ({ contentType, kind: 'image' });

function starts(buf: Uint8Array, sig: readonly number[]): boolean {
  if (buf.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return false;
  return true;
}
