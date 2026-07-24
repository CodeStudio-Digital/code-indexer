import { afterEach, describe, expect, it } from 'vitest';
import { filesToAttachments } from '../utils.js';

const desktopGlobal = globalThis as typeof globalThis & { electronAPI?: ElectronAPI };
const originalElectronAPI = desktopGlobal.electronAPI;

afterEach(() => {
  desktopGlobal.electronAPI = originalElectronAPI;
});

describe('desktop attachment references', () => {
  it('keeps an unsupported OS file as a path instead of reading its bytes', async () => {
    desktopGlobal.electronAPI = {
      getPathForFile: () => 'C:\\Temp\\48bc9f98.tmp',
    } as ElectronAPI;
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
    desktopGlobal.electronAPI = {
      getPathForFile: () => '',
    } as ElectronAPI;
    const file = new File(['opaque'], 'payload.tmp', { type: 'application/octet-stream' });

    await expect(filesToAttachments([file], [], { preferFileReferences: true }))
      .rejects.toThrow('Unsupported attachment type: payload.tmp');
  });
});
