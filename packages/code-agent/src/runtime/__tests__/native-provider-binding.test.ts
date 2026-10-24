import { expect, it, vi } from 'vitest';
import type { ChatProvider, ChatRequest } from '@mcp/provider-sdk/adapter.js';
import { bindNativeProductProvider } from '../native-provider-binding.js';

it('retains the configured account and mode while calling the chosen protocol adapter unchanged', async () => {
  const request = { system: 'system', messages: [], tools: [] } satisfies ChatRequest;
  const chat = vi.fn(async function* () { yield { type: 'done' as const }; });
  const provider: ChatProvider = { name: 'deepseek', model: 'vendor-model', chat,
    setModel(model) { this.model = model; } };
  const bound = bindNativeProductProvider(provider, { provider: 'my-account', model: 'vendor-model::chat' });
  expect(bound.name).toBe('my-account');
  expect(bound.model).toBe('vendor-model::chat');
  for await (const delta of bound.chat(request)) expect(delta.type).toBe('done');
  expect(chat).toHaveBeenCalledWith(request);
  expect(provider.name).toBe('deepseek');
  expect(provider.model).toBe('vendor-model');
  expect(() => bound.setModel('different')).toThrow('sealed');
  provider.setModel('different');
  expect(() => bound.chat(request)).toThrow('changed');
});
