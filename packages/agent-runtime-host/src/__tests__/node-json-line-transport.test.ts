import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { NodeJsonLineTransport } from '../engine-bakeoff/NodeJsonLineTransport.js';

describe('NodeJsonLineTransport', () => {
  it('reads and writes one bounded JSON value per line', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.setEncoding('utf8');
    const written: string[] = [];
    output.on('data', (value: string) => written.push(value));
    const transport = new NodeJsonLineTransport(input, output);

    const iterator = transport.messages()[Symbol.asyncIterator]();
    const nextMessage = iterator.next();
    input.write('{"method":"ready","params":{}}\n');
    await expect(nextMessage).resolves.toEqual({
      done: false,
      value: { method: 'ready', params: {} },
    });

    await transport.send({ id: 1, result: { ok: true } });
    expect(written.join('')).toBe('{"id":1,"result":{"ok":true}}\n');
    await transport.close();
  });

  it('rejects invalid JSON instead of skipping protocol corruption', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new NodeJsonLineTransport(input, output);
    const iterator = transport.messages()[Symbol.asyncIterator]();
    const nextMessage = iterator.next();
    input.write('{broken}\n');

    await expect(nextMessage).rejects.toMatchObject({ code: 'invalid_json_line' });
    await transport.close();
  });
});
