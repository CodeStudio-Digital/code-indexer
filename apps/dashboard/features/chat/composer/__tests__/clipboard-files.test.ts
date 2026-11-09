import { describe, expect, it } from 'vitest';
import { clipboardFiles } from '../clipboard-files.js';

describe('clipboard files', () => {
  it('leaves ordinary text paste alone', () => {
    expect(clipboardFiles({ items: [{ kind: 'string' }] as unknown as DataTransferItemList, files: [] as unknown as FileList })).toEqual([]);
  });
  it('extracts images and documents without duplicating the files fallback', () => {
    const image = new File(['png'], 'image.png', { type: 'image/png' });
    const doc = new File(['{}'], 'contrato.json', { type: 'application/json' });
    const result = clipboardFiles({ items: [image, doc].map(file => ({ kind: 'file', getAsFile: () => file })) as unknown as DataTransferItemList, files: [image, doc] as unknown as FileList });
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toMatch(/^pasted-.*-1\.png$/);
    expect(result[1]).toBe(doc);
  });
  it('accepts a native file-only clipboard payload', () => {
    const file = new File(['test'], 'note.txt', { type: 'text/plain' });
    expect(clipboardFiles({ items: [] as unknown as DataTransferItemList, files: [file] as unknown as FileList })).toEqual([file]);
  });
});
