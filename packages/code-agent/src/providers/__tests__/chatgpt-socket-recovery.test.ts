import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ChatGPTCodexProvider } from '../chatgpt.js';
import { consumeStream } from '../../core/runner/nodes/executing-stream.js';
import { providerErrorEvent } from '../../core/runner/nodes/executing-decisions.js';
import type { ChatRequest } from '../adapter.js';

function send(response: ServerResponse, event: Record<string, unknown>): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function withEndpoint(
  handler: (response: ServerResponse, attempt: number) => void,
  exercise: (provider: ChatGPTCodexProvider) => Promise<void>,
): Promise<void> {
  let attempt = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      handler(response, ++attempt);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test listener');
  try {
    await exercise(new ChatGPTCodexProvider({
      apiKey: 'local-test-only', baseURL: `http://127.0.0.1:${address.port}`, model: 'local-fixture',
    }));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

const request = (): ChatRequest => ({ system: 'test', messages: [], tools: [] });

describe('ChatGPT native fetch socket boundaries (local HTTP only)', () => {
  it('finishes at response.completed even when the server keeps the HTTP body open', async () => {
    await withEndpoint(response => {
      send(response, { type: 'response.output_text.delta', delta: 'complete' });
      send(response, { type: 'response.completed', response: { status: 'completed' } });
      // Deliberately no response.end(): terminal protocol event owns completion.
    }, async provider => {
      const result = await consumeStream({ stream: provider.chat(request()), idleTimeoutMs: 300 });
      expect(result.textBlocks).toEqual(['complete']);
    });
  });

  it('classifies a real mid-body disconnect and accepts only the next committed response', async () => {
    await withEndpoint((response, attempt) => {
      send(response, { type: 'response.output_text.delta', delta: attempt === 1 ? 'partial' : 'recovered' });
      if (attempt === 1) {
        const timer = setTimeout(() => response.destroy(), 25);
        response.once('close', () => clearTimeout(timer));
      } else {
        send(response, { type: 'response.completed', response: { status: 'completed' } });
        response.end();
      }
    }, async provider => {
      let failure: unknown;
      try { await consumeStream({ stream: provider.chat(request()) }); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(TypeError);
      expect(providerErrorEvent(failure)).toMatchObject({
        kind: 'ProviderError', status: 0, code: 'UND_ERR_SOCKET', retryable: true,
      });
      const result = await consumeStream({ stream: provider.chat(request()) });
      expect(result.textBlocks).toEqual(['recovered']);
    });
  });

  it('rejects clean EOF without the protocol terminal just like a truncated connection', async () => {
    await withEndpoint(response => {
      send(response, { type: 'response.output_text.delta', delta: 'partial' });
      response.end();
    }, async provider => {
      await expect(consumeStream({ stream: provider.chat(request()) }))
        .rejects.toMatchObject({ code: 'stream_ended_no_result' });
    });
  });
});
