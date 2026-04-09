/**
 * Bedrock AWS credential stash — /oauth/bedrock/credentials.
 *
 * Not OAuth in the strict sense: the user pastes access_key_id +
 * secret_access_key (+ optional session_token) in the admin UI and we store
 * them in oauth_tokens.extra so the Bedrock chat adapter + model discovery
 * can pick them up with the same lookup shape.
 *
 * We also refresh the provider row's `extra.aws_region` so the factory can
 * resolve region without touching oauth_tokens when credentials come from
 * the AWS default provider chain.
 */
import { Hono } from 'hono';
import type { ProviderStore } from '../../../store/provider-store.js';

export function bedrockOAuthRouter(store: ProviderStore): Hono {
  const app = new Hono();

  app.post('/oauth/bedrock/credentials', async (c) => {
    const body = await c.req.json<{
      provider_id?: string;
      access_key_id: string;
      secret_access_key: string;
      session_token?: string;
      region: string;
    }>();
    if (!body.access_key_id || !body.secret_access_key || !body.region) {
      return c.json({ error: 'access_key_id, secret_access_key, region required' }, 400);
    }
    const providerId = body.provider_id ?? 'bedrock';

    if (!store.getProvider(providerId)) {
      store.upsertProvider({
        id: providerId,
        name: 'Amazon Bedrock',
        kind: 'bedrock',
        auth_mode: 'aws_sigv4',
        enabled: true,
        use_for_coder: true,
        use_for_agent: false, // Indexer doesn't yet have a Bedrock adapter.
        extra: { aws_region: body.region },
      });
    } else {
      const existing = store.getProvider(providerId)!;
      store.upsertProvider({
        ...existing,
        extra: { ...existing.extra, aws_region: body.region },
      });
    }

    store.setOAuth({
      provider_id: providerId,
      // We don't have a real "access token" for AWS SigV4; store a dummy
      // marker so the row exists and getOAuth returns non-null.
      access_token: 'aws-sigv4',
      refresh_token: null,
      expires_at: null,
      scope: 'bedrock',
      extra: {
        accessKeyId: body.access_key_id,
        secretAccessKey: body.secret_access_key,
        sessionToken: body.session_token,
        region: body.region,
      },
    });

    return c.json({ ok: true, provider_id: providerId });
  });

  return app;
}
