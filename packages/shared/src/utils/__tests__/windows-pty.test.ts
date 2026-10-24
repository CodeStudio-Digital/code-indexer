import { afterEach, describe, expect, it, vi } from 'vitest';
import { electronWindowsPtyOptions } from '../windows-pty.js';

afterEach(() => vi.unstubAllGlobals());

describe('electronWindowsPtyOptions', () => {
  it('uses the bundled ConPTY backend for Windows Electron', () => {
    expect(electronWindowsPtyOptions('win32', '42.5.0')).toEqual({
      useConpty: true,
      useConptyDll: true,
    });
  });

  it('leaves ordinary Node on node-pty defaults', () => {
    vi.stubGlobal('process', {
      ...process,
      platform: 'win32',
      versions: { ...process.versions, electron: undefined },
    });
    expect(electronWindowsPtyOptions()).toEqual({});
  });

  it('leaves non-Windows hosts on node-pty defaults', () => {
    expect(electronWindowsPtyOptions('linux', '42.5.0')).toEqual({});
    expect(electronWindowsPtyOptions('darwin', '42.5.0')).toEqual({});
  });
});
