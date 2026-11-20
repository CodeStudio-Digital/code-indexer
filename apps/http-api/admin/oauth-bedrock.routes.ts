import { HttpRouter } from '@mcp/shared/http/router.js';
import type { ProviderStore } from '@mcp/store/provider-store.js';

export function bedrockOAuthRouter(store: ProviderStore): HttpRouter {
  const app = new HttpRouter();
  app.post('/oauth/bedrock/credentials', async c => {
    const body = await c.req.json<{
      provider_id?: string; method?: 'default' | 'iam' | 'api-key'; access_key_id?: string;
      secret_access_key?: string; session_token?: string; bedrock_api_key?: string; region?: string;
    }>();
    const region = body.region?.trim();
    const method = body.method ?? 'iam';
    if (!region || !/^[a-z]{2}(?:-[a-z\d]+)+-\d+$/.test(region)) {
      return c.json({ error: 'A valid AWS region is required.' }, 400);
    }
    if (!['default', 'iam', 'api-key'].includes(method)) return c.json({ error: 'Invalid AWS auth method.' }, 400);
    const accessKeyId = body.access_key_id?.trim();
    const secretAccessKey = body.secret_access_key?.trim();
    const bedrockApiKey = body.bedrock_api_key?.trim();
    if (method === 'iam' && (!accessKeyId || !secretAccessKey)) {
      return c.json({ error: 'IAM access key and secret access key are required.' }, 400);
    }
    if (method === 'api-key' && !bedrockApiKey) return c.json({ error: 'A Bedrock API key is required.' }, 400);

    const id = body.provider_id ?? 'bedrock';
    const existing = store.getProvider(id);
    if (existing && existing.kind !== 'bedrock') {
      return c.json({ error: 'Invalid Bedrock provider.' }, 409);
    }
    store.upsertProvider({
      ...existing, id, kind: 'bedrock', name: existing?.name ?? 'AWS Bedrock',
      auth_mode: 'aws_sigv4', api_key: null, enabled: true,
      use_for_coder: true, use_for_agent: existing?.use_for_agent ?? false,
      extra: { ...existing?.extra, aws_region: region, aws_credential_method: method },
    });
    if (method === 'default') {
      store.deleteOAuth(id);
    } else {
      store.setOAuth({
        provider_id: id, access_token: 'bedrock-credentials', refresh_token: null,
        expires_at: null, scope: 'bedrock',
        extra: method === 'api-key'
          ? { bedrockApiKey, region }
          : { accessKeyId, secretAccessKey, sessionToken: body.session_token?.trim() || undefined, region },
      });
    }
    return c.json({ ok: true, provider_id: id });
  });
  return app;
}
