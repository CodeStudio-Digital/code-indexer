import { describe, it, expect } from 'vitest';
import {
  extractAttachmentText,
  normalizeAttachmentsForModel,
} from '../attachment-extract.js';

// RTF is constructible inline (plain text), so these tests are hermetic — no
// binary fixtures. officeparser handles rtf/docx/xlsx/… identically.
function rtfBase64(body: string): string {
  return Buffer.from(`{\\rtf1\\ansi\\deff0 ${body}}`).toString('base64');
}

describe('extractAttachmentText', () => {
  it('extracts text from a document and clears the base64', async () => {
    const [out] = await extractAttachmentText({
      name: 'notes.rtf',
      mediaType: 'application/rtf',
      base64: rtfBase64('Hello from a document.\\par Second line.'),
    });
    expect(out.text).toContain('Hello from a document.');
    expect(out.text).toContain('Second line.');
    expect(out.base64).toBeUndefined();
  });

  it('detects parseable format by extension even with a generic mediaType', async () => {
    const [out] = await extractAttachmentText({
      name: 'memo.rtf',
      mediaType: 'application/octet-stream',
      base64: rtfBase64('Extension wins.'),
    });
    expect(out.text).toContain('Extension wins.');
    expect(out.base64).toBeUndefined();
  });

  it('keeps Office bytes for providers with general native file input', async () => {
    const base64 = rtfBase64('Native transport.');
    const [out] = await extractAttachmentText({
      name: 'memo.rtf',
      mediaType: 'application/rtf',
      base64,
    }, { keepBinaryDocuments: true });
    expect(out.base64).toBe(base64);
    expect(out.text).toBeUndefined();
  });

  it('passes images through untouched', async () => {
    const [out] = await extractAttachmentText({
      name: 'shot.png',
      mediaType: 'image/png',
      base64: 'AAAA',
    });
    expect(out.base64).toBe('AAAA');
    expect(out.text).toBeUndefined();
  });

  it('passes pre-decoded text through untouched', async () => {
    const [out] = await extractAttachmentText({
      name: 'a.ts',
      mediaType: 'text/plain',
      text: 'const x = 1;',
    });
    expect(out.text).toBe('const x = 1;');
  });

  it('keeps PDF base64 (Anthropic-native) — does not extract', async () => {
    const [out] = await extractAttachmentText({
      name: 'paper.pdf',
      mediaType: 'application/pdf',
      base64: 'JVBERi0=',
    });
    expect(out.base64).toBe('JVBERi0=');
    expect(out.text).toBeUndefined();
  });

  it('degrades to a note (never throws) on unreadable bytes', async () => {
    const [out] = await extractAttachmentText({
      name: 'broken.docx',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      base64: Buffer.from('not a real zip').toString('base64'),
    });
    expect(out.text).toContain('could not be read');
    expect(out.base64).toBeUndefined();
  });

  it('turns an unsupported binary into an explicit note instead of silently dropping it', async () => {
    const [out] = await extractAttachmentText({
      name: 'archive.bin',
      mediaType: 'application/octet-stream',
      base64: Buffer.from('opaque bytes').toString('base64'),
    });
    expect(out.text).toContain('unsupported binary file type');
    expect(out.base64).toBeUndefined();
  });
});

describe('normalizeAttachmentsForModel', () => {
  it('preserves undefined', async () => {
    expect(await normalizeAttachmentsForModel(undefined)).toBeUndefined();
    expect(await normalizeAttachmentsForModel([])).toBeUndefined();
  });

  it('normalizes a mixed batch', async () => {
    const out = await normalizeAttachmentsForModel([
      { name: 'doc.rtf', mediaType: 'application/rtf', base64: rtfBase64('Batch body.') },
      { name: 'pic.png', mediaType: 'image/png', base64: 'ZZZZ' },
    ]);
    expect(out).toHaveLength(2);
    expect(out![0].text).toContain('Batch body.');
    expect(out![1].base64).toBe('ZZZZ');
  });
});
