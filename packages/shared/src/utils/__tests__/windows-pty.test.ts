import { describe, expect, it } from 'vitest';
import { electronWindowsPtyOptions } from '../windows-pty.js';

describe('electronWindowsPtyOptions', () => {
  it('uses the bundled ConPTY backend for Windows Electron', () => {
    expect(electronWindowsPtyOptions('win32', '42.5.0')).toEqual({
      useConpty: true,
      useConptyDll: true,
    });
  });

  it('leaves ordinary Node and non-Windows hosts on node-pty defaults', () => {
    expect(electronWindowsPtyOptions('win32', undefined)).toEqual({});
    expect(electronWindowsPtyOptions('linux', '42.5.0')).toEqual({});
    expect(electronWindowsPtyOptions('darwin', '42.5.0')).toEqual({});
  });
});
