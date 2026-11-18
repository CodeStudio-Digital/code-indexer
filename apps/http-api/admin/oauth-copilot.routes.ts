import { Hono } from 'hono';
import { startCopilotClient, stopCopilotClient } from '@mcp/code-agent/providers/copilot-sdk-client.js';
import { mapCopilotModel } from '@mcp/provider-engine/discovery/copilot-models.js';
import { isRetiredProviderId } from '@mcp/shared/providers/local-edition.js';
import type { ProviderStore } from '@mcp/store/provider-store.js';

type Client = Awaited<ReturnType<typeof startCopilotClient>>;
type LoginSession = Awaited<ReturnType<Client['createSession']>>;
type Flow = { client: Client; session: LoginSession; providerId: string; timer: ReturnType<typeof setTimeout>; advancing: boolean };

export function copilotOAuthRouter(store: ProviderStore): Hono {
  const app = new Hono();
  const flows = new Map<string, Flow>();

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
    for (const [flowId, flow] of flows) {
      if (flow.providerId === providerId) await close(flowId, true);
    }
    let client: Client | undefined;
    try {
      client = await startCopilotClient(providerId);
      const session = await client.createSession({
        tools: { availableTools: [] },
        github: { telemetryEnabled: false },
      });
      const { flowId, step: first } = await session.rpc.accounts.login.begin({
        kind: enterprise ? 'proxima' : 'githubDotCom', method: 'device-code',
      });
      const step = first.kind === 'input-required' && host
        ? await session.rpc.accounts.login.advance({ flowId, input: host }) : first;
      if (step.kind !== 'device-code') {
        throw new Error(step.kind === 'error' ? step.message : 'GitHub did not return a device code.');
      }
      const timer = setTimeout(() => void close(flowId, true), step.expiresIn * 1000);
      timer.unref();
      flows.set(flowId, { client, session, providerId, timer, advancing: false });
      return c.json({ device_code: flowId, user_code: step.userCode, verification_uri: step.verificationUri,
        expires_in: step.expiresIn, interval: step.interval });
    } catch (error) {
      if (client) await stopCopilotClient(client);
      return c.json({ error: (error as Error).message }, 502);
    }
  });

  app.post('/oauth/copilot/poll', async c => {
    const { device_code: flowId } = await c.req.json<{ device_code: string }>();
    const flow = flows.get(flowId);
    if (!flow) return c.json({ status: 'expired' }, 404);
    if (flow.advancing) return c.json({ status: 'pending' }, 409);
    flow.advancing = true;
    const cancel = () => void close(flowId, true);
    c.req.raw.signal.addEventListener('abort', cancel, { once: true });
    try {
      const step = await flow.session.rpc.accounts.login.advance({ flowId });
      if (step.kind !== 'completed' || step.result.status !== 'completed') {
        const reason = step.kind === 'error' ? step.message : 'GitHub sign-in was not completed.';
        return c.json({ status: 'error', error: reason }, 401);
      }
      const models = (await flow.client.listModels()).filter(model => model.policy?.state !== 'disabled').map(mapCopilotModel);
      if (flows.get(flowId) !== flow) return c.json({ status: 'expired' }, 410);
      const current = store.getProvider(flow.providerId);
      if (current && current.kind !== 'copilot') return c.json({ status: 'error', error: 'Invalid Copilot provider' }, 409);
      store.upsertProvider({
        ...current, id: flow.providerId, name: current?.name ?? 'GitHub Copilot', kind: 'copilot',
        api_key: null, base_url: null, auth_mode: 'oauth', enabled: true, use_for_coder: true,
        use_for_agent: current?.use_for_agent ?? false,
        extra: { githubLogin: step.result.login, githubHost: step.result.host },
      });
      store.deleteOAuth(flow.providerId);
      store.replaceModelsFromSource(flow.providerId, 'live', models);
      return c.json({ status: 'authorized', provider_id: flow.providerId, model_count: models.length });
    } catch (error) {
      return c.json({ status: 'error', error: (error as Error).message }, 502);
    } finally {
      c.req.raw.signal.removeEventListener('abort', cancel);
      await close(flowId, false);
    }
  });

  app.post('/oauth/copilot/cancel', async c => {
    const { device_code } = await c.req.json<{ device_code: string }>();
    await close(device_code, true);
    return c.json({ ok: true });
  });

  return app;
}
