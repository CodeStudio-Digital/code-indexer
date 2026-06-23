import { describe, it, expect, vi } from 'vitest';

// Mock the shared PDF parser so we don't need a real PDF fixture or `unpdf`.
vi.mock('../pdf-parser.js', () => ({
  parsePdf: vi.fn(async () => [
    { markdown: 'Page one text.' },
    { markdown: 'Page two text.' },
  ]),
}));

import { extractAttachmentText, pdfHandledNatively } from '../attachment-extract.js';

const PDF = 'application/pdf';
const FAKE_PDF_B64 = 'JVBERi0xLjQK'; // not a real PDF; parsePdf is mocked

describe('extractAttachmentText — PDF provider-aware', () => {
  it('extracts text and DROPS base64 when extractPdfText is true (non-native provider)', async () => {
    const parts = await extractAttachmentText(
      { name: 'report.pdf', mediaType: PDF, base64: FAKE_PDF_B64 },
      { extractPdfText: true },
    );
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toContain('Page one text.');
    expect(parts[0].text).toContain('Page two text.');
    expect(parts[0].base64).toBeUndefined();
  });

  it('keeps base64 and does NOT extract for native providers (extractPdfText false)', async () => {
    const parts = await extractAttachmentText(
      { name: 'report.pdf', mediaType: PDF, base64: FAKE_PDF_B64 },
      { extractPdfText: false },
    );
    expect(parts).toHaveLength(1);
    expect(parts[0].base64).toBe(FAKE_PDF_B64);
    expect(parts[0].text).toBeUndefined();
  });

  it('defaults to keeping base64 when no opts are passed', async () => {
    const [out] = await extractAttachmentText({ name: 'report.pdf', mediaType: PDF, base64: FAKE_PDF_B64 });
    expect(out.base64).toBe(FAKE_PDF_B64);
    expect(out.text).toBeUndefined();
  });

  it('detects PDF by extension even with a generic mediaType', async () => {
    const [out] = await extractAttachmentText(
      { name: 'doc.PDF', mediaType: 'application/octet-stream', base64: FAKE_PDF_B64 },
      { extractPdfText: true },
    );
    expect(out.text).toContain('Page one text.');
    expect(out.base64).toBeUndefined();
  });
});

describe('pdfHandledNatively', () => {
  it('is true only for the adapters that render base64 PDF', () => {
    for (const k of ['anthropic', 'claude-code', 'gemini', 'google-oauth', 'ANTHROPIC']) {
      expect(pdfHandledNatively(k)).toBe(true);
    }
  });

  it('is false for everyone else, unknown, and undefined (safe default → extract)', () => {
    for (const k of ['chatgpt', 'openai', 'kimi-code', 'bedrock', 'zai', 'openrouter', 'deepseek', '']) {
      expect(pdfHandledNatively(k)).toBe(false);
    }
    expect(pdfHandledNatively(undefined)).toBe(false);
    expect(pdfHandledNatively(null)).toBe(false);
  });
});
