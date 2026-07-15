import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { encodeMessage, FrameParser } from '../jsonrpc-framing.js';
import { LspRpcClient } from '../lsp-client.js';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('LspRpcClient', () => {
  it('sends $/cancelRequest when a timed-out request is abandoned', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = { stdin, stdout, stderr } as unknown as ChildProcessWithoutNullStreams;
    const sent: Array<Record<string, unknown>> = [];
    const parser = new FrameParser();
    stdin.on('data', (chunk: Buffer) => {
      sent.push(...parser.push(chunk).map((message) => message as Record<string, unknown>));
    });
    const client = new LspRpcClient(child);

    await expect(client.request('textDocument/hover', {}, 10)).rejects.toThrow('timed out');

    expect(sent).toEqual([
      expect.objectContaining({ id: 1, method: 'textDocument/hover' }),
      { jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 1 } },
    ]);
    client.dispose();
  });

  it('sends $/cancelRequest immediately when the caller aborts', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = { stdin, stdout, stderr } as unknown as ChildProcessWithoutNullStreams;
    const sent: Array<Record<string, unknown>> = [];
    const parser = new FrameParser();
    stdin.on('data', (chunk: Buffer) => {
      sent.push(...parser.push(chunk).map((message) => message as Record<string, unknown>));
    });
    const client = new LspRpcClient(child);
    const controller = new AbortController();

    const pending = client.request('textDocument/codeAction', {}, 10_000, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(sent).toEqual([
      expect.objectContaining({ id: 1, method: 'textDocument/codeAction' }),
      { jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 1 } },
    ]);
    client.dispose();
  });

  it('captures workspace/applyEdit and acknowledges it to command-backed servers', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = { stdin, stdout, stderr } as unknown as ChildProcessWithoutNullStreams;
    const sent: Array<Record<string, unknown>> = [];
    const parser = new FrameParser();
    stdin.on('data', (chunk: Buffer) => {
      sent.push(...parser.push(chunk).map((message) => message as Record<string, unknown>));
    });
    const edits: unknown[] = [];
    const client = new LspRpcClient(child, undefined, undefined, (edit) => {
      edits.push(edit);
      return true;
    });
    const edit = {
      changes: {
        'file:///D:/game/Player.cs': [{
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
          newText: 'next',
        }],
      },
    };

    stdout.write(encodeMessage({
      jsonrpc: '2.0',
      id: 91,
      method: 'workspace/applyEdit',
      params: { label: 'Use expression body', edit },
    }));
    await flush();

    expect(edits).toEqual([edit]);
    expect(sent).toContainEqual({ jsonrpc: '2.0', id: 91, result: { applied: true } });
    client.dispose();
  });

  it('drains stdout in multiple turns while preserving order and completeness', async () => {
    vi.useFakeTimers();
    try {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = { stdin, stdout, stderr } as unknown as ChildProcessWithoutNullStreams;
      const seen: unknown[] = [];
      const client = new LspRpcClient(child);
      client.onNotification('$/progress', (params) => seen.push(params));

      const total = 3_200;
      stdout.write(Buffer.concat(Array.from({ length: total }, (_, i) =>
        encodeMessage({ jsonrpc: '2.0', method: '$/progress', params: { i } }))));
      expect(seen).toHaveLength(0);

      await vi.advanceTimersToNextTimerAsync();
      expect(seen).toHaveLength(32);
      await vi.advanceTimersToNextTimerAsync();
      expect(seen).toHaveLength(64);
      await vi.runAllTimersAsync();
      expect(seen).toEqual(Array.from({ length: total }, (_, i) => ({ i })));
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles server→client requests and acks dispose without draining further', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = { stdin, stdout, stderr } as unknown as ChildProcessWithoutNullStreams;
    const sent: Array<Record<string, unknown>> = [];
    const parser = new FrameParser();
    stdin.on('data', (chunk: Buffer) => {
      sent.push(...parser.push(chunk).map((message) => message as Record<string, unknown>));
    });
    const client = new LspRpcClient(child);
    client.onRequest('test/echo', async (params) => params);

    stdout.write(encodeMessage({ jsonrpc: '2.0', id: 7, method: 'test/echo', params: { ok: true } }));
    await flush();
    client.dispose();
    stdout.write(encodeMessage({ jsonrpc: '2.0', method: '$/progress', params: { late: true } }));
    await flush();

    expect(sent).toContainEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } });
    expect(sent.filter((m) => m.method === '$/progress')).toHaveLength(0);
  });
});
