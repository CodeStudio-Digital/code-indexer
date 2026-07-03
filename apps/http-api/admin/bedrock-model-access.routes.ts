/**
 * Bedrock model access management — check and subscribe to foundation models
 * programmatically via the AWS Bedrock control-plane API.
 *
 * Routes:
 *   GET  /bedrock/model-access/:modelId  — check current access status
 *   POST /bedrock/model-access/:modelId  — subscribe (create agreement)
 */
import { Hono } from 'hono';
import type { ProviderStore } from '@mcp/store/provider-store.js';
import {
  checkModelAccess,
  requestModelAccess,
  type UseCaseFormData,
} from './bedrock-model-access.js';

export function bedrockModelAccessRouter(store: ProviderStore): Hono {
  const app = new Hono();

  function getBedrockCfg(providerId?: string) {
    const id = providerId ?? 'bedrock';
    const cfg = store.getProvider(id);
    if (!cfg) throw new Error(`Bedrock provider "${id}" not found. Configure credentials first.`);
    return cfg;
  }

  // GET /bedrock/model-access/:modelId
  app.get('/bedrock/model-access/:modelId', async (c) => {
    const modelId = c.req.param('modelId');
    const providerId = c.req.query('provider_id');
    try {
      const cfg = getBedrockCfg(providerId);
      const status = await checkModelAccess(store, cfg, modelId);
      return c.json(status);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // POST /bedrock/model-access/:modelId
  // Body (all optional):
  //   provider_id?: string
  //   use_case?: UseCaseFormData   — Anthropic-only, skipped if already submitted
  app.post('/bedrock/model-access/:modelId', async (c) => {
    const modelId = c.req.param('modelId');
    let body: { provider_id?: string; use_case?: UseCaseFormData } = {};
    try {
      body = await c.req.json();
    } catch {
      // empty body is fine — all fields are optional
    }
    try {
      const cfg = getBedrockCfg(body.provider_id);
      const result = await requestModelAccess(store, cfg, modelId, body.use_case);
      return c.json(result);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  return app;
}
