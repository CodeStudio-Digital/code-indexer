import { afterEach, describe, expect, it, vi } from 'vitest';
import { filesToAttachments } from '../utils.js';


afterEach(() => {
  vi.unstubAllGlobals();
});

describe('desktop attachment references', () => {
  it('keeps an unsupported OS file as a path instead of reading its bytes', async () => {
    vi.stubGlobal('electronAPI', {
      getPathForFile: () => 'C:\\Temp\\48bc9f98.tmp',
    } satisfies Pick<ElectronAPI, 'getPathForFile'>);
    const file = new File([new Uint8Array([0, 1, 2, 3])], '48bc9f98.tmp', {
      type: 'application/octet-stream',
    });

    const result = await filesToAttachments([file], [], { preferFileReferences: true });

    expect(result).toEqual([{
      name: '48bc9f98.tmp',
      mediaType: 'application/octet-stream',
      path: 'C:\\Temp\\48bc9f98.tmp',
    }]);
  });

  it('retains the portable rejection when no native reference exists', async () => {
    vi.stubGlobal('electronAPI', {
      getPathForFile: () => '',
    } satisfies Pick<ElectronAPI, 'getPathForFile'>);
    const file = new File(['opaque'], 'payload.tmp', { type: 'application/octet-stream' });

    await expect(filesToAttachments([file], [], { preferFileReferences: true }))
      .rejects.toThrow('Unsupported attachment type: payload.tmp');
  });
});
