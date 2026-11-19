import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeIndexDB } from '@mcp/store/db.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { copilotOAuthRouter } from '../oauth-copilot.routes.js';

const runtime = vi.hoisted(() => ({
  start: vi.fn(), create: vi.fn(), stop: vi.fn(),
  begin: vi.fn(), advance: vi.fn(), cancel: vi.fn(),
  deleteSession: vi.fn(), listModels: vi.fn(),
}));

vi.mock('@mcp/code-agent/providers/copilot-sdk-client.js', () => ({
  startCopilotClient: runtime.start, createCopilotSession: runtime.create, stopCopilotClient: runtime.stop,
}));

const device = { kind: 'device-code', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 };
const selection = { selectionId: 'fixture-identity', login: 'fixture-user', host: 'github.com', kind: 'githubDotCom' };
const completed = { kind: 'completed', result: { status: 'completed', login: selection.login, host: selection.host } };
const active = { device_code: 'sdk-flow' };
let db: CodeIndexDB;
let store: ProviderStore;
let app: ReturnType<typeof copilotOAuthRouter>;

beforeEach(() => {
  vi.resetAllMocks();
  db = new CodeIndexDB(':memory:');
  store = new ProviderStore(db.raw());
  app = copilotOAuthRouter(store);
  runtime.start.mockResolvedValue({ deleteSession: runtime.deleteSession, listModels: runtime.listModels });
  runtime.create.mockResolvedValue({ sessionId: 'sdk-session', rpc: { accounts: {
    login: { begin: runtime.begin, advance: runtime.advance, cancel: runtime.cancel },
  } } });
  runtime.deleteSession.mockResolvedValue(undefined);
  runtime.cancel.mockResolvedValue(undefined);
  runtime.stop.mockResolvedValue(undefined);
  runtime.begin.mockResolvedValue({ flowId: 'sdk-flow', step: device });
  runtime.listModels.mockResolvedValue([
    { id: 'fixture-model', name: 'Fixture Model', capabilities: { supports: {} } },
    { id: 'disabled-model', name: 'Disabled Model', capabilities: {}, policy: { state: 'disabled' } },
  ]);
});

afterEach(async () => {
  await post('cancel', active);
  db.close();
});

function post(path: string, body: object) {
  return app.request('/oauth/copilot/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('GitHub Copilot sign-in', () => {
  it('keeps the SDK flow alive while waiting and accepts the selected account', async () => {
    expect(await (await post('start', {})).json()).toMatchObject({ ...active, user_code: 'ABCD-EFGH' });
    runtime.advance.mockResolvedValueOnce({ kind: 'awaiting' }).mockResolvedValueOnce({
      kind: 'completed', result: { status: 'needs-account-selection', accounts: [selection] },
    }).mockResolvedValueOnce(completed);

    const first = await post('poll', active);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: 'pending', interval: 5 });
    const choices = { status: 'choose_account', accounts: [{ selectionId: selection.selectionId, login: selection.login, host: selection.host }] };
    expect(await (await post('poll', active)).json()).toEqual(choices);
    expect(await (await post('poll', active)).json()).toEqual(choices);
    expect((await post('poll', { ...active, selection_id: 'unoffered' })).status).toBe(400);
    expect(runtime.advance).toHaveBeenCalledTimes(2);
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.listModels).not.toHaveBeenCalled();

    expect(await (await post('poll', { ...active, selection_id: selection.selectionId })).json()).toEqual({
      status: 'authorized', provider_id: 'copilot', model_count: 1,
    });
    expect(runtime.advance).toHaveBeenLastCalledWith({ flowId: 'sdk-flow', input: selection.selectionId });
    expect(store.getProvider('copilot')).toMatchObject({ enabled: true, auth_mode: 'oauth', extra: { githubLogin: 'fixture-user' } });
    expect(store.listModels('copilot').map(model => model.model_id)).toEqual(['fixture-model']);
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect((await post('poll', active)).status).toBe(410);
  });

  it('closes with a specific credential-vault error if the SDK asks for plaintext storage', async () => {
    await post('start', {});
    runtime.advance.mockResolvedValueOnce({ kind: 'completed', result: { status: 'needs-plaintext-consent' } });
    const reply = await post('poll', active);
    expect(reply.status).toBe(409);
    expect(await reply.json()).toMatchObject({ status: 'error', code: 'credential_store_unavailable' });
    expect(runtime.advance).toHaveBeenCalledTimes(1);
    expect(runtime.cancel).toHaveBeenCalledWith({ flowId: 'sdk-flow' });
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(runtime.listModels).not.toHaveBeenCalled();
  });

  it('passes the Enterprise Cloud host to the device login and cancels on close', async () => {
    runtime.begin.mockResolvedValueOnce({ flowId: 'sdk-flow', step: { kind: 'input-required', prompt: 'Host' } });
    runtime.advance.mockResolvedValueOnce(device);
    const reply = await post('start', { edition: 'enterprise', ghes_host: ' Example.ghe.com ' });
    expect(reply.status).toBe(200);
    expect(runtime.start).toHaveBeenCalledWith('copilot-enterprise');
    expect(runtime.begin).toHaveBeenCalledWith({ kind: 'proxima', method: 'device-code' });
    expect(runtime.advance).toHaveBeenCalledWith({ flowId: 'sdk-flow', input: 'example.ghe.com' });
    await post('cancel', active);
    expect(runtime.cancel).toHaveBeenCalledTimes(1);
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect((await post('poll', active)).status).toBe(410);
  });

  it('never saves a provider when the login was cancelled during an SDK call', async () => {
    await post('start', {});
    let finish!: (step: typeof completed) => void;
    runtime.advance.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const response = post('poll', active);
    await vi.waitFor(() => expect(runtime.advance).toHaveBeenCalledTimes(1));
    expect(await (await post('poll', active)).json()).toMatchObject({ status: 'pending' });
    await post('cancel', active);
    finish(completed);
    expect((await response).status).toBe(410);
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(runtime.listModels).not.toHaveBeenCalled();
  });
});
