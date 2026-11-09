import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildOpenAICompat } from '../wires/openai-compat.js';
import { buildOpenAICompat as buildPluginRuntime } from '@mcp/provider-runtime/wires/openai-compat.js';
import { openaiSpec } from '../specs/openai-compat.js';

let server: Server;
let baseURL: string;
let requests: Array<{ url: string; authorization?: string; body: Record<string, unknown> }>;

beforeEach(async () => {
  requests = [];
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ url: request.url!, authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'local-fixture', choices: [{ index: 0, delta: { content: 'Local Gemini' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local fixture port');
  baseURL = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe.each([['built-in', buildOpenAICompat], ['plugin runtime', buildPluginRuntime]] as const)('%s custom OpenAI-compatible instance', (_name, build) => {
  it.each(['/', '/v1/'])('sends the selected Gemini model to a keyless local endpoint at %s', async (path) => {
    vi.stubEnv('OPENAI_API_KEY', 'must-not-use-another-provider-key');
    const provider = build(openaiSpec).createCoder!({ baseURL: `${baseURL}${path}` }, 'antigravity/gemini-4-argon-medium');
    const deltas = [];
    for await (const delta of provider.chat({ system: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'Oi' }] }], tools: [] })) deltas.push(delta);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${path}chat/completions`);
    expect(requests[0]?.body.model).toBe('antigravity/gemini-4-argon-medium');
    expect(requests[0]?.authorization ?? '').not.toContain('must-not-use-another-provider-key');
    expect(JSON.stringify(deltas)).toContain('Local Gemini');
  });

  it('retains a custom endpoint and its own configured credential for GPT models too', async () => {
    const provider = build(openaiSpec).createCoder!({ baseURL, apiKey: 'local-fixture-key' }, 'gpt-local');
    for await (const _delta of provider.chat({ system: '', messages: [], tools: [] })) { /* drain */ }
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: '/chat/completions', authorization: 'Bearer local-fixture-key', body: { model: 'gpt-local' } });
  });

  it('still rejects a missing key for the official OpenAI API', () => {
    expect(() => build(openaiSpec).createCoder!({}, 'gpt-6.1-sol')).toThrow('requires an API key');
  });
});
