import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyText } from '../clipboard.js';
import { createMonacoClipboardService } from '../monaco-clipboard-service.js';

vi.mock('../clipboard.js', () => ({
  copyText: vi.fn(async () => true),
}));

const copyTextMock = vi.mocked(copyText);
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function setNavigator(value: Navigator): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value,
  });
}

describe('createMonacoClipboardService', () => {
  beforeEach(() => {
    copyTextMock.mockClear();
  });

  afterEach(() => {
    if (originalNavigator) {
      Object.defineProperty(globalThis, 'navigator', originalNavigator);
    } else {
      Reflect.deleteProperty(globalThis, 'navigator');
    }
  });

  it('writes plain text through the dashboard fallback helper', async () => {
    const clipboard = {
      write: vi.fn(),
      writeText: vi.fn(),
      readText: vi.fn(),
    };
    setNavigator({ clipboard } as unknown as Navigator);

    const service = createMonacoClipboardService();
    await service.writeText('copy me');

    expect(copyTextMock).toHaveBeenCalledWith('copy me');
    expect(clipboard.write).not.toHaveBeenCalled();
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it('keeps Monaco typed clipboard values in memory only', async () => {
    const service = createMonacoClipboardService();

    await service.writeText('metadata', 'vscode-editor-data');

    expect(await service.readText('vscode-editor-data')).toBe('metadata');
    expect(copyTextMock).not.toHaveBeenCalled();
  });

  it('returns empty text when browser clipboard reads are denied', async () => {
    const clipboard = {
      readText: vi.fn(async () => {
        throw new DOMException('denied', 'NotAllowedError');
      }),
    };
    setNavigator({ clipboard } as unknown as Navigator);

    const service = createMonacoClipboardService();

    await expect(service.readText()).resolves.toBe('');
  });
});
