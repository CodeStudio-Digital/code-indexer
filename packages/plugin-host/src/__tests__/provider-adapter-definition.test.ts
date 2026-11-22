import { describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { withReasoningCapabilities, withStreamResilience, type AgentMessage,
  type ChatDelta, type ChatProvider, type ProviderDefinition, type ProviderRuntimeAdapter, type ProviderSpec } from '@mcp/provider-sdk';
import { ChatGPTCodexProvider } from '@mcp/code-agent/providers/chatgpt.js';
import { bindProviderReplay } from '@mcp/code-agent/core/provider-replay.js';
import { consumeStream } from '@mcp/code-agent/core/runner/nodes/executing-stream.js';

const { importBundleMock } = vi.hoisted(() => ({ importBundleMock: vi.fn() }));

vi.mock('../import-plugin-bundle.js', () => ({ importPluginBundle: importBundleMock }));

import { buildProviderPluginDefinition } from '../provider-adapter-definition.js';

const spec: ProviderSpec = {
  kind: 'acme',
  displayName: 'Acme',
  credKind: 'api-key',
  envVars: [],
  defaultModels: ['acme-default'],
  pricing: {},
  wire: 'openai-compat',
};

let fixtureId = 0;
function fixture(adapter: ProviderRuntimeAdapter, hostCreate?: ProviderDefinition['createCoder']) {
  importBundleMock.mockResolvedValue({ providerAdapter: adapter });
  return buildProviderPluginDefinition(spec, {
    namespace: `provider-reuse-${++fixtureId}`, file: `fixture-${fixtureId}.js`, kinds: ['acme'],
  }, { ...spec, createCoder: hostCreate });
}
async function consume(client: ChatProvider) {
  const result: ChatDelta[] = [];
  for await (const delta of client.chat({ system: '', messages: [], tools: [] })) result.push(delta);
  return result;
}
function statefulClient(model = 'acme-model'): ChatProvider {
  let calls = 0;
  return { name: 'acme', model, inferenceOnly: true,
    reasoningCapabilities: { canReason: true, supportedLevels: ['high'] },
    toolLimits: { maxCount: 64, source: 'fixture' },
    setModel(value) { this.model = value; },
    async *chat() { yield { type: 'text_delta', text: `${this.model}:${++calls}` }; },
  };
}

describe('plugin provider client lifecycle', () => {
  it('resolves the real text-only capability without sending a chat request', async () => {
    const adapter = statefulClient();
    const chat = vi.spyOn(adapter, 'chat');
    const create = vi.fn().mockResolvedValue(adapter);
    const definition = fixture({ sdkVersion: 2, kind: 'acme', createCoder: create });
    const provider = definition.createCoder!({ apiKey: 'fixture' }, 'selected', { textOnly: true });
    expect(provider.inferenceOnly).toBeUndefined();
    await Promise.all([provider.prepare!(), provider.prepare!()]);
    expect(provider.inferenceOnly).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled();
  });

  it('keeps Responses continuation through the plugin and wrappers across completed runner requests', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing port');
    const requests: Record<string, unknown>[] = [];
    let connections = 0;
    server.on('connection', (socket) => {
      connections++;
      socket.on('message', (raw) => {
        requests.push(JSON.parse(raw.toString()) as Record<string, unknown>);
        const output = [{ type: 'message', id: `msg_${requests.length}`, role: 'assistant',
          status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }];
        socket.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' }));
        socket.send(JSON.stringify({ type: 'response.completed', response: { id: `resp_${requests.length}`, output } }));
      });
    });
    const clients: ChatGPTCodexProvider[] = [];
    const create = vi.fn(() => {
      const client = new ChatGPTCodexProvider({ apiKey: 'fixture', model: 'gpt-6.1-sol',
        baseURL: `http://127.0.0.1:${address.port}`, websocketMode: true });
      clients.push(client);
      return client;
    });
    try {
      const deferred = fixture({ sdkVersion: 2, kind: 'acme', createCoder: create }).createCoder!({ apiKey: 'fixture' }, 'gpt-6.1-sol');
      const client = withStreamResilience(withReasoningCapabilities(deferred, undefined));
      const messages: AgentMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'first' }] }];
      for (let turn = 0; turn < 2; turn++) {
        const controller = new AbortController();
        const result = await consumeStream({ stream: client.chat({ system: '', messages, tools: [],
          sessionId: 'plugin-transport-test', signal: controller.signal }), signal: controller.signal });
        controller.abort(); // ExecutingNode always cleans up the per-request controller.
        expect(result.responseMeta?.timing).toMatchObject({ transport: 'websocket', incremental: turn === 1 });
        const assistant: AgentMessage = { role: 'assistant', phase: result.messagePhase,
          content: result.textBlocks.map((text) => ({ type: 'text' as const, text })) };
        expect(result.providerReplay).not.toBeNull();
        bindProviderReplay(assistant, result.providerReplay!);
        messages.push(assistant, { role: 'user', content: [{ type: 'text', text: 'next' }] });
      }
      expect(create).toHaveBeenCalledTimes(1);
      expect(connections).toBe(1);
      expect(requests[1]).toMatchObject({ previous_response_id: 'resp_1', input: [expect.objectContaining({ role: 'user' })] });
      expect(client.inferenceOnly).toBe(true);
    } finally {
      for (const client of clients) client.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(['plugin', 'host'] as const)('reuses a %s client and exposes its verified capabilities after initialization', async (owner) => {
    const create = vi.fn(() => statefulClient());
    const definition = fixture({ sdkVersion: 2, kind: 'acme', ...(owner === 'plugin' ? { createCoder: create } : {}) }, create);
    const client = definition.createCoder!({ apiKey: 'fixture-key' }, 'selected');
    expect(client.inferenceOnly).toBeUndefined(); // A lazy, unknown plugin is conservative.
    expect(await consume(client)).toEqual([{ type: 'text_delta', text: 'selected:1' }]);
    expect(client.inferenceOnly).toBe(true);
    expect(client.toolLimits?.maxCount).toBe(64);
    expect(client.reasoningCapabilities?.supportedLevels).toEqual(['high']);
    client.setModel('selected');
    expect(await consume(client)).toEqual([{ type: 'text_delta', text: 'selected:2' }]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('rebuilds model-dependent options and never shares clients between credentials', async () => {
    const create = vi.fn(({ model }: { model?: string }) => statefulClient(model));
    const definition = fixture({ sdkVersion: 2, kind: 'acme', createCoder: create });
    const first = definition.createCoder!({ apiKey: 'account-one' }, 'one');
    const other = definition.createCoder!({ apiKey: 'account-two' }, 'one');
    await consume(first);
    first.setModel('two');
    expect(first.inferenceOnly).toBeUndefined();
    expect(await consume(first)).toEqual([{ type: 'text_delta', text: 'two:1' }]);
    expect(await consume(other)).toEqual([{ type: 'text_delta', text: 'one:1' }]);
    expect(create.mock.calls.map(([ctx]) => ctx.model)).toEqual(['one', 'two', 'one']);
    expect(create).toHaveBeenNthCalledWith(3, expect.objectContaining({ creds: { apiKey: 'account-two' } }));
  });

  it('coalesces concurrent initialization and retries failed client creation', async () => {
    let release!: (client: ChatProvider) => void;
    const create = vi.fn().mockRejectedValueOnce(new Error('initialization failed'))
      .mockImplementationOnce(() => new Promise<ChatProvider>((resolve) => { release = resolve; }));
    const definition = fixture({ sdkVersion: 2, kind: 'acme', createCoder: create });
    const client = definition.createCoder!({ apiKey: 'fixture' }, 'selected');
    await expect(consume(client)).rejects.toThrow('initialization failed');
    const a = consume(client), b = consume(client);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    release(statefulClient());
    expect(await Promise.all([a, b])).toEqual([
      [{ type: 'text_delta', text: 'selected:1' }], [{ type: 'text_delta', text: 'selected:2' }],
    ]);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not publish old capabilities when an earlier model finishes initialization late', async () => {
    let release!: (client: ChatProvider) => void;
    const create = vi.fn().mockImplementationOnce(() => new Promise<ChatProvider>((resolve) => { release = resolve; }))
      .mockImplementationOnce(() => ({ ...statefulClient(), inferenceOnly: false }));
    const client = fixture({ sdkVersion: 2, kind: 'acme', createCoder: create }).createCoder!({ apiKey: 'fixture' }, 'old');
    const old = consume(client);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    client.model = 'new';
    await consume(client);
    release(statefulClient());
    await old;
    expect(client.inferenceOnly).toBe(false);
    expect(client.model).toBe('new');
    await consume(client);
    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe('buildProviderPluginDefinition host wire fallback', () => {
  it('keeps auth/discovery in the plugin and shared runtime methods in the host', async () => {
    importBundleMock.mockResolvedValue({
      providerAdapter: {
        sdkVersion: 2,
        kind: 'acme',
        resolveCredentials: vi.fn(async () => ({ apiKey: 'plugin-key' })),
      },
    });

    const hostClient: ChatProvider = {
      name: 'acme',
      model: 'acme-model',
      setModel: vi.fn(function setModel(this: ChatProvider, model: string) { this.model = model; }),
      async *chat() { yield { type: 'text_delta', text: 'ok' } satisfies ChatDelta; },
    };
    const hostDefinition: ProviderDefinition = {
      kind: 'acme',
      displayName: 'Acme',
      credKind: 'api-key',
      envVars: [],
      defaultModels: ['acme-default'],
      pricing: {},
      fetchModels: vi.fn(async () => ['from-host']),
      testConnection: vi.fn(async () => undefined),
      createCoder: vi.fn(() => hostClient),
    };
    const definition = buildProviderPluginDefinition(spec, {
      namespace: 'provider-acme',
      file: 'C:\\plugins\\provider-acme\\dist\\plugin.js',
      kinds: ['acme'],
    }, hostDefinition);
    const creds = { apiKey: 'key' };

    await expect(definition.fetchModels?.(creds)).resolves.toEqual(['from-host']);
    const config = { id: 'acme-1', kind: 'acme' };
    await definition.testConnection?.({ config, creds });
    const client = definition.createCoder?.(creds, 'chosen-model');
    const chunks: ChatDelta[] = [];
    for await (const chunk of client!.chat({} as never)) chunks.push(chunk);

    expect(hostDefinition.fetchModels).toHaveBeenCalledWith(creds);
    expect(hostDefinition.testConnection).toHaveBeenCalledWith({ config, creds });
    expect(hostDefinition.createCoder).toHaveBeenCalledWith(creds, 'chosen-model', undefined);
    expect(chunks).toEqual([{ type: 'text_delta', text: 'ok' }]);
  });
});
