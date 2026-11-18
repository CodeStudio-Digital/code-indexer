import { Hono } from 'hono';
import { createCopilotSession, startCopilotClient, stopCopilotClient } from '@mcp/code-agent/providers/copilot-sdk-client.js';
import { mapCopilotModel } from '@mcp/provider-engine/discovery/copilot-models.js';
import { isRetiredProviderId } from '@mcp/shared/providers/local-edition.js';
import type { ProviderStore } from '@mcp/store/provider-store.js';

type Client = Awaited<ReturnType<typeof startCopilotClient>>;
type LoginSession = Awaited<ReturnType<typeof createCopilotSession>>;
type AccountChoice = { selectionId: string; login: string; host: string };
type Flow = {
  client: Client;
  session: LoginSession;
  providerId: string;
  timer: ReturnType<typeof setTimeout>;
  interval: number;
  advancing: boolean;
  accounts?: AccountChoice[];
};

export function copilotOAuthRouter(store: ProviderStore): Hono {
  const app = new Hono();
  const flows = new Map<string, Flow>();
  const starting = new Set<string>();

  async function close(flowId: string, cancel: boolean) {
    const flow = flows.get(flowId);
    if (!flow) return;
    flows.delete(flowId);
    clearTimeout(flow.timer);
    if (cancel) await flow.session.rpc.accounts.login.cancel({ flowId }).catch(() => {});
    await flow.client.deleteSession(flow.session.sessionId).catch(() => {});
    await stopCopilotClient(flow.client);
  }

  app.post('/oauth/copilot/start', async c => {
    const body = await c.req.json<{ edition?: string; ghes_host?: string; provider_id?: string }>().catch(() => ({}));
    const enterprise = 'edition' in body && body.edition === 'enterprise';
    const host = 'ghes_host' in body ? body.ghes_host?.trim().toLowerCase() : undefined;
    if (enterprise && !/^[a-z0-9-]+\.ghe\.com$/.test(host ?? '')) {
      return c.json({ error: 'Enter the GitHub Enterprise Cloud host (organization.ghe.com).' }, 400);
    }
    const providerId = ('provider_id' in body ? body.provider_id : undefined)
      ?? (enterprise ? 'copilot-enterprise' : 'copilot');
    const existing = store.getProvider(providerId);
    if (isRetiredProviderId(providerId) || (existing && existing.kind !== 'copilot')) {
      return c.json({ error: 'Invalid Copilot provider' }, 409);
    }
    if (starting.has(providerId)) return c.json({ error: 'Copilot sign-in is already starting for this provider.' }, 409);
    starting.add(providerId);
    let client: Client | undefined;
    let session: LoginSession | undefined;
    let sdkFlowId: string | undefined;
    try {
      for (const [flowId, flow] of flows) {
        if (flow.providerId === providerId) await close(flowId, true);
      }
      client = await startCopilotClient(providerId);
      c.req.raw.signal.throwIfAborted();
      session = await createCopilotSession(client);
      const { flowId, step: first } = await session.rpc.accounts.login.begin({
        kind: enterprise ? 'proxima' : 'githubDotCom', method: 'device-code',
      });
      sdkFlowId = flowId;
      const step = first.kind === 'input-required' && host
        ? await session.rpc.accounts.login.advance({ flowId, input: host }) : first;
      if (step.kind !== 'device-code') {
        throw new Error(step.kind === 'error' ? step.message : 'GitHub did not return a device code.');
      }
      c.req.raw.signal.throwIfAborted();
      const timer = setTimeout(() => void close(flowId, true), step.expiresIn * 1000);
      timer.unref();
      const interval = Number.isFinite(step.interval) && step.interval > 0 ? Math.ceil(step.interval) : 5;
      flows.set(flowId, { client, session, providerId, timer, interval, advancing: false });
      return c.json({ device_code: flowId, user_code: step.userCode, verification_uri: step.verificationUri,
        expires_in: step.expiresIn, interval });
    } catch (error) {
      if (sdkFlowId && session) await session.rpc.accounts.login.cancel({ flowId: sdkFlowId }).catch(() => {});
      if (session && client) await client.deleteSession(session.sessionId).catch(() => {});
      if (client) await stopCopilotClient(client);
      return c.json({ error: (error as Error).message }, 502);
    } finally {
      starting.delete(providerId);
    }
  });

  app.post('/oauth/copilot/poll', async c => {
    const { device_code: flowId, selection_id: selection } = await c.req.json<{ device_code: string; selection_id?: string }>();
    const flow = flows.get(flowId);
    if (!flow) return c.json({ status: 'expired' }, 410);
    if (flow.advancing) return c.json({ status: 'pending', interval: flow.interval });
    if (flow.accounts && selection === undefined) return c.json({ status: 'choose_account', accounts: flow.accounts });
    if (selection !== undefined && !flow.accounts?.some(account => account.selectionId === selection)) {
      return c.json({ status: 'error', error: 'Choose an account from the active GitHub Copilot sign-in.' }, 400);
    }
    flow.advancing = true;
    let keepOpen = false;
    let authorized = false;
    const cancel = () => void close(flowId, true);
    const signal = c.req.raw.signal;
    signal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted();
      const step = await flow.session.rpc.accounts.login.advance({ flowId, ...(selection !== undefined ? { input: selection } : {}) });
      if (flows.get(flowId) !== flow) return c.json({ status: 'expired' }, 410);
      flow.accounts = undefined;
      if (step.kind === 'awaiting' || step.kind === 'needs-interaction') {
        keepOpen = true;
        return c.json({ status: 'pending', interval: flow.interval });
      }
      if (step.kind === 'error') return c.json({ status: 'error', error: step.message }, 401);
      if (step.kind !== 'completed') {
        return c.json({ status: 'error', error: 'Unexpected GitHub Copilot login step (' + step.kind + ').' }, 502);
      }
      if (step.result.status === 'needs-account-selection') {
        const accounts = step.result.accounts?.map(({ selectionId, login, host }) => ({ selectionId, login, host }));
        if (!accounts?.length) return c.json({ status: 'error', error: 'GitHub Copilot returned no accounts to select.' }, 502);
        flow.accounts = accounts;
        keepOpen = true;
        return c.json({ status: 'choose_account', accounts });
      }
      if (step.result.status === 'needs-plaintext-consent') {
        return c.json({
          status: 'error', code: 'credential_store_unavailable',
          error: 'Copilot could not use the system credential vault. Enable the vault, then sign in again.',
        }, 409);
      }
      if (step.result.status === 'declined') {
        return c.json({ status: 'error', code: 'declined', error: 'Copilot credential storage was declined.' }, 401);
      }
      const models = (await flow.client.listModels()).filter(model => model.policy?.state !== 'disabled').map(mapCopilotModel);
      if (flows.get(flowId) !== flow) return c.json({ status: 'expired' }, 410);
      const current = store.getProvider(flow.providerId);
      if (current && current.kind !== 'copilot') return c.json({ status: 'error', error: 'Invalid Copilot provider' }, 409);
      store.saveCopilotConnection({
        ...current, id: flow.providerId, name: current?.name ?? 'GitHub Copilot', kind: 'copilot',
        api_key: null, base_url: null, auth_mode: 'oauth', enabled: true, use_for_coder: true,
        use_for_agent: current?.use_for_agent ?? false,
        extra: { ...current?.extra, githubLogin: step.result.login, githubHost: step.result.host },
      }, models);
      authorized = true;
      return c.json({ status: 'authorized', provider_id: flow.providerId, model_count: models.length });
    } catch (error) {
      return c.json({ status: 'error', error: (error as Error).message }, 502);
    } finally {
      signal.removeEventListener('abort', cancel);
      flow.advancing = false;
      if (!keepOpen) await close(flowId, !authorized);
    }
  });

  app.post('/oauth/copilot/cancel', async c => {
    const { device_code } = await c.req.json<{ device_code: string }>();
    await close(device_code, true);
    return c.json({ ok: true });
  });

  return app;
}
