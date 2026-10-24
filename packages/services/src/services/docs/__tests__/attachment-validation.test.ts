import { afterEach, describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAttachments } from '../attachment-validation.js';

function b64(value: string): string {
  return Buffer.from(value).toString('base64');
}

function zipBase64(entries: Record<string, string>): string {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) zip.addFile(name, Buffer.from(content));
  return zip.toBuffer().toString('base64');
}

describe('validateAttachments', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('accepts and canonicalizes a real PDF signature', () => {
    const result = validateAttachments([
      { name: '../report.pdf', mediaType: 'application/octet-stream', base64: b64('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF') },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.[0]).toMatchObject({ name: 'report.pdf', mediaType: 'application/pdf' });
  });

  it('rejects MIME or extension spoofing before provider dispatch', () => {
    const result = validateAttachments([
      { name: 'fake.pdf', mediaType: 'application/pdf', base64: b64('not a pdf') },
    ]);
    expect(result).toMatchObject({ ok: false, code: 'ATTACHMENT_CONTENT_MISMATCH' });
  });

  it('rejects encrypted PDFs with a clear error', () => {
    const result = validateAttachments([
      { name: 'secret.pdf', mediaType: 'application/pdf', base64: b64('%PDF-1.7\n/Encrypt 1 0 R\n%%EOF') },
    ]);
    expect(result).toMatchObject({ ok: false, code: 'PDF_UNSUPPORTED' });
  });

  it('requires exactly one payload representation', () => {
    const result = validateAttachments([
      { name: 'a.txt', mediaType: 'text/plain', text: 'hello', base64: b64('hello') },
    ]);
    expect(result).toMatchObject({ ok: false, code: 'ATTACHMENT_AMBIGUOUS' });
  });

  it('rejects base64 smuggling through a text filename', () => {
    const result = validateAttachments([
      { name: 'payload.txt', mediaType: 'text/plain', base64: b64('opaque binary') },
    ]);
    expect(result).toMatchObject({ ok: false, code: 'ATTACHMENT_ENCODING_INVALID' });
  });

  it('accepts many images within the payload budget', () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      name: `image-${i}.png`,
      mediaType: 'image/png',
      base64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64'),
    }));
    const result = validateAttachments(items);
    expect(result.ok && result.value?.length).toBe(25);
  });

  it('rejects unsupported binary file types', () => {
    const result = validateAttachments([
      { name: 'payload.exe', mediaType: 'application/octet-stream', base64: b64('MZ') },
    ]);
    expect(result).toMatchObject({ ok: false, code: 'ATTACHMENT_UNSUPPORTED' });
  });

  it('accepts any regular file type as an exact local reference when enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'attachment-reference-'));
    tempDirs.push(dir);
    const path = join(dir, '48bc9f98.tmp');
    writeFileSync(path, Buffer.from([0, 1, 2, 3]));

    const result = validateAttachments([
      { name: '48bc9f98.tmp', mediaType: 'application/octet-stream', path },
    ], { allowFileReferences: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.[0]).toEqual({
      name: '48bc9f98.tmp',
      mediaType: 'application/octet-stream',
      path,
    });
  });

  it('rejects local references on surfaces without filesystem authorization', () => {
    const result = validateAttachments([
      { name: 'a.tmp', mediaType: 'application/octet-stream', path: 'C:\\temp\\a.tmp' },
    ]);
    expect(result).toMatchObject({ ok: false, code: 'ATTACHMENT_REFERENCE_UNSUPPORTED' });
  });

  it('rejects an image whose bytes contradict its extension and MIME type', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]).toString('base64');
    const result = validateAttachments([
      { name: 'not-really.png', mediaType: 'image/png', base64: jpeg },
    ]);
    expect(result).toMatchObject({ ok: false, code: 'ATTACHMENT_CONTENT_MISMATCH' });
  });

  it('accepts a structurally plausible DOCX envelope', () => {
    const result = validateAttachments([{
      name: 'report.docx',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      base64: zipBase64({
        '[Content_Types].xml': '<Types/>',
        'word/document.xml': '<document/>',
      }),
    }]);
    expect(result.ok).toBe(true);
  });

  it('rejects an arbitrary ZIP renamed to DOCX', () => {
    const result = validateAttachments([{
      name: 'archive.docx',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      base64: zipBase64({ 'random.txt': 'not an Office document' }),
    }]);
    expect(result).toMatchObject({ ok: false, code: 'ATTACHMENT_ARCHIVE_UNSAFE' });
  });
});
