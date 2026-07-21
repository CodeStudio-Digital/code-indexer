import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { DapConnection } from '../dap-connection.js';

function frame(message: unknown): Buffer {
  const json = JSON.stringify(message);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function decodeFrame(buffer: Buffer): any {
  const split = buffer.indexOf('\r\n\r\n');
  return JSON.parse(buffer.subarray(split + 4).toString('utf8'));
}

describe('DapConnection', () => {
  it('correlates a response split across chunks', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const dap = new DapConnection(input, output);
    const written = new Promise<Buffer>((resolve) => output.once('data', (chunk) => resolve(Buffer.from(chunk))));
    const pending = dap.request<{ ok: boolean }>('initialize', { clientID: 'mcp' });
    const request = decodeFrame(await written);
    const response = frame({
      seq: 2,
      type: 'response',
      request_seq: request.seq,
      success: true,
      command: 'initialize',
      body: { ok: true },
    });
    input.write(response.subarray(0, 11));
    input.write(response.subarray(11));
    await expect(pending).resolves.toEqual({ ok: true });
    dap.close();
  });

  it('delivers coalesced events', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const dap = new DapConnection(input, output);
    const events: string[] = [];
    dap.onEvent<{ value: string }>('output', (body) => events.push(body.value));
    input.write(Buffer.concat([
      frame({ seq: 1, type: 'event', event: 'output', body: { value: 'a' } }),
      frame({ seq: 2, type: 'event', event: 'output', body: { value: 'b' } }),
    ]));
    expect(events).toEqual(['a', 'b']);
    dap.close();
  });

  it('answers a reverse request through an allowlisted handler', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const dap = new DapConnection(input, output);
    dap.onRequest('runInTerminal', async () => ({ processId: 42 }));
    const written = new Promise<Buffer>((resolve) => output.once('data', (chunk) => resolve(Buffer.from(chunk))));
    input.write(frame({ seq: 8, type: 'request', command: 'runInTerminal', arguments: {} }));
    const response = decodeFrame(await written);
    expect(response).toMatchObject({
      type: 'response',
      request_seq: 8,
      success: true,
      body: { processId: 42 },
    });
    dap.close();
  });
});
