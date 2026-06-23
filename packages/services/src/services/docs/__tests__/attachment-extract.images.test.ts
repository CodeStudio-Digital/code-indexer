import { describe, it, expect, vi } from 'vitest';

// base64 string whose decoded length ≈ `bytes` (the module estimates size as
// floor(data.length * 3 / 4)).
function b64OfBytes(bytes: number): string {
  return 'A'.repeat(Math.ceil((bytes * 4) / 3));
}

// Mock the dynamic `import('officeparser')` so we control the AST — no binary
// docx fixture needed. The RTF round-trip against the real lib lives in the
// sibling `attachment-extract.test.ts`.
vi.mock('officeparser', () => ({
  parseOffice: vi.fn(
    async (_buf: Buffer, cfg?: { extractAttachments?: boolean }) => ({
      toText: () => 'Document body text.',
      attachments: cfg?.extractAttachments
        ? [
            // 8 valid rasters → exercises the per-doc cap (6)
            ...Array.from({ length: 8 }, (_v, i) => ({
              type: 'image' as const,
              mimeType: 'image/png',
              data: b64OfBytes(10 * 1024),
              name: `pic${i}.png`,
            })),
            { type: 'image', mimeType: 'image/svg+xml', data: b64OfBytes(10 * 1024), name: 'vector.svg' }, // wrong mime
            { type: 'image', mimeType: 'image/png', data: b64OfBytes(1 * 1024), name: 'tiny.png' }, // too small
            { type: 'chart', mimeType: 'image/png', data: b64OfBytes(10 * 1024), name: 'chart.png' }, // not an image
          ]
        : [],
    }),
  ),
}));

import { extractAttachmentText, normalizeAttachmentsForModel } from '../attachment-extract.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('extractAttachmentText — embedded images', () => {
  it('emits the text doc + filtered, capped image blocks when extractImages is on', async () => {
    const parts = await extractAttachmentText(
      { name: 'report.docx', mediaType: DOCX, base64: 'ZHVtbXk=' },
      { extractImages: true },
    );
    // First part is the text document; base64 cleared.
    expect(parts[0].text).toContain('Document body text.');
    expect(parts[0].base64).toBeUndefined();

    const imgs = parts.filter((p) => p.mediaType.startsWith('image/'));
    // svg + tiny + chart all dropped; 8 valid pngs capped at 6.
    expect(imgs).toHaveLength(6);
    expect(imgs.every((p) => p.mediaType === 'image/png' && p.base64)).toBe(true);
    expect(imgs[0].name).toContain('report.docx');
  });

  it('does NOT extract images when extractImages is off (default)', async () => {
    const parts = await extractAttachmentText({ name: 'report.docx', mediaType: DOCX, base64: 'ZHVtbXk=' });
    expect(parts.every((p) => !p.mediaType.startsWith('image/'))).toBe(true);
    expect(parts[0].text).toContain('Document body text.');
  });

  it('flattens images into the batch via normalizeAttachmentsForModel', async () => {
    const out = await normalizeAttachmentsForModel(
      [{ name: 'd.docx', mediaType: DOCX, base64: 'ZHVtbXk=' }],
      { extractImages: true },
    );
    // 1 text + 6 images = 7 flattened entries.
    expect(out).toHaveLength(7);
    expect(out!.filter((p) => p.mediaType.startsWith('image/'))).toHaveLength(6);
  });
});
