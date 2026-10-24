import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { OpenAIChatProvider } from '../openai.js';
import { KimiCodeChatProvider } from '../kimi-code.js';
import { consumeStream } from '../../core/runner/nodes/executing-stream.js';

describe('OpenAI-compatible HTTP cancellation', () => {
  it.each(['compat', 'kimi'].flatMap(kind => [false, true].map(firstChunk => ({ kind, firstChunk }))))(
    'closes $kind transport when cancelled (first chunk: $firstChunk)', async ({ kind, firstChunk }) => {
    let onRequest!: () => void;
    let onClose!: () => void;
    const requested = new Promise<void>(resolve => { onRequest = resolve; });
    const closed = new Promise<void>(resolve => { onClose = resolve; });
    const server = createServer((request, response) => {
      request.resume();
      response.on('close', onClose);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (firstChunk) response.write(`data: ${JSON.stringify({ id: 'local', choices: [
        { index: 0, delta: { content: 'partial' }, finish_reason: null },
      ] })}\n\n`);
      else response.flushHeaders();
      onRequest();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No loopback port');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const config = { apiKey: 'local-fixture', model: 'fixture', baseURL: `http://127.0.0.1:${address.port}/v1` };
      const provider = kind === 'kimi' ? new KimiCodeChatProvider(config)
        : new OpenAIChatProvider({ ...config, vendor: 'deepseek' });
      const consumed = consumeStream({ signal: controller.signal, stream: provider.chat({
        system: 'fixture', messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }],
        tools: [], signal: controller.signal,
      }) }).then(() => undefined, error => error);
      await requested;
      controller.abort();
      const stopped = Promise.all([consumed, closed]);
      const [error] = await Promise.race([stopped, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('cancel did not close the provider transport')), 2_000);
      })]);
      expect(error).toMatchObject({ code: 'ABORTED' });
    } finally {
      clearTimeout(timer);
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
