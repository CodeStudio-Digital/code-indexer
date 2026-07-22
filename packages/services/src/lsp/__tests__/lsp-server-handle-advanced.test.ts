import { describe, expect, it, vi } from 'vitest';
import {
  ADVANCED_TEXT_DOCUMENT_CAPABILITIES,
  LspServerHandle,
} from '../lsp-server-handle.js';

interface ScheduledJob {
  priority: string;
  key?: string;
  signal?: AbortSignal;
  run(signal: AbortSignal): Promise<unknown>;
}

function handleHarness() {
  const rpcRequest = vi.fn().mockResolvedValue([]);
  const schedule = vi.fn((job: ScheduledJob) =>
    job.run(job.signal ?? new AbortController().signal));
  const handle = Object.create(LspServerHandle.prototype) as LspServerHandle;
  Object.assign(handle as unknown as Record<string, unknown>, {
    rpc: { request: rpcRequest },
    scheduler: { schedule },
  });
  return { handle, rpcRequest, schedule };
}

describe('LspServerHandle advanced document requests', () => {
  it('advertises only the advanced capabilities the renderer implements', () => {
    expect(ADVANCED_TEXT_DOCUMENT_CAPABILITIES).toEqual({
      typeDefinition: { dynamicRegistration: false, linkSupport: true },
      foldingRange: {
        dynamicRegistration: false,
        lineFoldingOnly: true,
        foldingRangeKind: { valueSet: ['comment', 'imports', 'region'] },
      },
      inlayHint: { dynamicRegistration: false },
      linkedEditingRange: { dynamicRegistration: false },
    });
    expect(ADVANCED_TEXT_DOCUMENT_CAPABILITIES.inlayHint).not.toHaveProperty('resolveSupport');
  });

  it('reports only advanced features advertised by the server', () => {
    const { handle } = handleHarness();
    Object.assign(handle as unknown as Record<string, unknown>, {
      capabilities: {
        typeDefinitionProvider: true,
        foldingRangeProvider: {},
        inlayHintProvider: false,
      },
    });

    expect(handle.supportsTypeDefinition()).toBe(true);
    expect(handle.supportsFoldingRanges()).toBe(true);
    expect(handle.supportsInlayHints()).toBe(false);
    expect(handle.supportsLinkedEditingRanges()).toBe(false);
  });

  it('converts public 1-based positions/ranges to 0-based LSP requests', async () => {
    const { handle, rpcRequest, schedule } = handleHarness();
    const controller = new AbortController();
    const file = 'D:\\repo\\src\\app.component.html';

    await handle.typeDefinition(file, { line: 7, column: 9 }, controller.signal);
    await handle.foldingRanges(file, controller.signal);
    await handle.inlayHints(file, {
      start: { line: 2, column: 3 },
      end: { line: 8, column: 5 },
    }, controller.signal);
    await handle.linkedEditingRanges(file, { line: 4, column: 6 }, controller.signal);

    const calls = rpcRequest.mock.calls;
    expect(calls[0][0]).toBe('textDocument/typeDefinition');
    expect(calls[0][1]).toEqual({
      textDocument: { uri: 'file:///d:/repo/src/app.component.html' },
      position: { line: 6, character: 8 },
    });
    expect(calls[1][0]).toBe('textDocument/foldingRange');
    expect(calls[1][1]).toEqual({
      textDocument: { uri: 'file:///d:/repo/src/app.component.html' },
    });
    expect(calls[2][0]).toBe('textDocument/inlayHint');
    expect(calls[2][1]).toEqual({
      textDocument: { uri: 'file:///d:/repo/src/app.component.html' },
      range: {
        start: { line: 1, character: 2 },
        end: { line: 7, character: 4 },
      },
    });
    expect(calls[3][0]).toBe('textDocument/linkedEditingRange');
    expect(calls[3][1]).toEqual({
      textDocument: { uri: 'file:///d:/repo/src/app.component.html' },
      position: { line: 3, character: 5 },
    });

    expect(schedule.mock.calls.map(([job]) => ({
      priority: job.priority,
      key: job.key,
      signal: job.signal,
    }))).toEqual([
      { priority: 'manual', key: undefined, signal: controller.signal },
      { priority: 'background', key: `folding:${file}`, signal: controller.signal },
      { priority: 'background', key: `inlayHints:${file}`, signal: controller.signal },
      { priority: 'interactive', key: `linkedEditing:${file}`, signal: controller.signal },
    ]);
    expect(calls.every((call) => call[3] === controller.signal)).toBe(true);
  });
});
