import { describe, expect, it, vi } from 'vitest';
import type { ProviderModel } from '@mcp/store/provider-store.js';
import type { ChildChatPort } from '../../ports/child-chat-port.js';
import { routeChildChats, validateChildChatTarget } from '../child-chat-routing.js';

const parent = { provider: 'meridian', model: 'claude-opus-4-7-medium' };
const configured = { provider: 'openai-chatgpt', model: 'gpt-6.2-sol', effort: 'xhigh' };
const original = 'Agora vc vai coordenar uns 2 3 agentes (um chat para cada) com provider chatgpt codex, modelo sol 6.2 no xhigth';
const task = { key: 'k', profile: 'implement', title: 'A', task: 'A', wait: false };

function model(model_id: string, name: string, overrides: Partial<ProviderModel> = {}): ProviderModel {
  return { model_id, name, mode: '', enabled: true, can_reason: true,
    supported_reasoning_levels: ['low', 'xhigh', 'max'], ...overrides } as ProviderModel;
}

function fixture(text = original) {
  const identities = [
    { id: 'openai-chatgpt', name: 'ChatGPT (Codex)', kind: 'chatgpt', enabled: true },
    { id: 'meridian', name: 'Meridian', kind: 'openai', enabled: true },
    { id: 'disabled', name: 'Disabled', kind: 'chatgpt', enabled: false },
  ];
  const models = [model(configured.model, 'GPT-6.2-Sol'), model('gpt-5-codex', 'GPT-5-Codex'),
    model('gpt-6.2-astra', 'GPT-6.2-Astra'), model('retired', 'Retired', { enabled: false })];
  const catalog = { listProviderIdentities: () => identities, listModels: (id: string) => id === 'openai-chatgpt'
    ? models : [model(parent.model, 'Claude Opus 4.7 Medium'), model(configured.model, 'GPT-6.2-Sol')] };
  const create = vi.fn<ChildChatPort['create']>().mockResolvedValue({ chatId: 'child', title: 'A', readOnly: false, created: true, profile: 'implement' });
  const port = routeChildChats({ create, wait: vi.fn(), stop: vi.fn(), message: vi.fn(), list: vi.fn() }, catalog, parent, async () => text);
  return { create, catalog, models, identities, send: (fields = {}) => port.create('parent', { ...task, ...fields }), next: (value: string) => { text = value; } };
}

describe('child chat target selection', () => {
  it('refuses even an enabled older guess, the same model on another provider, wrong effort and omitted targets before dispatch', async () => {
    const f = fixture();
    for (const fields of [
      { provider: 'openai-chatgpt', model: 'gpt-5-codex', effort: 'xhigh' },
      { provider: 'codex', model: 'gpt-5.2-codex', effort: 'xhigh' },
      { provider: 'chatgpt-codex', model: 'gpt-5.2', effort: 'xhigh' }, {},
      { model: 'gpt-5.2-codex', effort: 'xhigh' }, { ...configured, provider: 'meridian' }, { ...configured, effort: 'low' },
    ]) {
      await expect(f.send(fields)).rejects.toThrow(JSON.stringify(configured));
    }
    expect(f.create).not.toHaveBeenCalled();
    await Promise.all(['chatgpt-codex', 'Codex', 'ChatGPT (Codex)'].map((provider, i) =>
      f.send({ title: String(i), provider, model: 'Sol 6.2' })));
    expect(f.create).toHaveBeenCalledTimes(3);
    for (const [, request] of f.create.mock.calls) expect(request).toMatchObject({ ...configured, wait: false });
    f.next('Abra um chat com as configurações do perfil.');
    await f.send();
    expect(f.create.mock.lastCall?.[1]).toEqual(task);
  });

  it('recognizes the natural ChatGPT/Astra request with a quoted model', async () => {
    const f = fixture('Usa o ChatGPT com "Astra 6.2" no max pra essa tarefa.');
    await expect(f.send()).rejects.toThrow('gpt-6.2-astra');
    await f.send({ model: 'gpt-6.2-astra' });
    expect(f.create.mock.lastCall?.[1]).toMatchObject({ provider: 'openai-chatgpt', model: 'gpt-6.2-astra', effort: 'max' });
  });

  it.each([
    ['Usa o provider chatgpt/ modelo Astra 6.2 no max para tal tarefa.', 'max'],
    ['Use o ChatGPT com o modelo Astra 6.2. Revise o arquivo.', undefined],
  ])('recognizes a selection in "%s"', async (message, effort) => {
    const f = fixture(message!);
    await expect(f.send()).rejects.toThrow('gpt-6.2-astra');
    await f.send({ provider: 'Codex', model: 'Astra 6.2' });
    expect(f.create.mock.lastCall?.[1]).toMatchObject({ provider: 'openai-chatgpt', model: 'gpt-6.2-astra' });
    expect(f.create.mock.lastCall?.[1].effort).toBe(effort);
  });

  it('keeps normal inheritance, ignores quoted instructions and prevents stripping a failed explicit selection on retry', async () => {
    const f = fixture('Abra chats para revisar os exemplos:\n> ' + original + '\n```text\n' + original + '\n```');
    await f.send();
    await f.send({ effort: 'low' });
    await expect(f.send({ provider: 'wrong', model: 'missing' })).rejects.toThrow('mcp__list_models');
    await expect(f.send()).rejects.toThrow('requested target');
    await f.send(configured);
    await f.send();
    expect(f.create.mock.calls.map(([, r]) => r)).toEqual([task, { ...task, effort: 'low' }, { ...task, ...configured }, task]);
  });

  it('requires supported efforts, enabled models and unambiguous provider aliases or mode IDs', async () => {
    const f = fixture('Delegate this task.');
    f.identities.push({ id: 'other-login', name: 'Other login', kind: 'chatgpt', enabled: true });
    await expect(f.send({ provider: 'Codex', model: 'Sol 6.2' })).rejects.toThrow('Ambiguous provider');
    expect(() => validateChildChatTarget(f.catalog, 'disabled', configured.model)).toThrow('disabled');
    expect(() => validateChildChatTarget(f.catalog, configured.provider, 'retired')).toThrow('disabled');
    expect(() => validateChildChatTarget(f.catalog, configured.provider, configured.model, 'medium')).toThrow('Supported: low, xhigh, max');
    f.models.push(model('glm', 'GLM', { mode: 'coding' }), model('glm', 'GLM', { mode: 'normal' }));
    await expect(f.send({ provider: configured.provider, model: 'GLM' })).rejects.toThrow('ambiguous');
    await f.send({ provider: configured.provider, model: 'glm::coding' });
    expect(f.create.mock.lastCall?.[1].model).toBe('glm::coding');
  });

  it('keeps the explicit effort when host validation fails on an inherited profile model', async () => {
    const f = fixture('Delegate a task.');
    f.create.mockRejectedValueOnce(new Error('Effort unavailable'));
    await expect(f.send({ effort: 'xhigh' })).rejects.toThrow('Effort unavailable');
    await expect(f.send()).rejects.toThrow('requested target');
    expect(f.create).toHaveBeenCalledTimes(1);
  });
});
