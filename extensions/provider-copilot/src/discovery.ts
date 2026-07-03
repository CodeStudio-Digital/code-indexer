import { getRegistryContextWindow } from '@mcp/code-agent/providers/capabilities.js';
import type {
  ProviderDiscoverModelsContext,
  ProviderDiscoveredModel,
  ProviderDiscoveryResult,
} from '@mcp/provider-sdk';
import { copilotHeaders, type CopilotOAuthOptions } from './auth.js';

export async function discoverCopilotModels(
  ctx: ProviderDiscoverModelsContext,
): Promise<ProviderDiscoveryResult> {
  const token = ctx.creds.apiKey ?? '';
  if (!token) throw new Error('No Copilot token. Connect Copilot in the admin UI.');

  const opts = readCopilotOpts(ctx.creds.extra?.copilotOpts);
  const base = (ctx.creds.baseURL ?? ctx.config.base_url ?? 'https://api.githubcopilot.com').replace(/\/$/, '');
  const response = await ctx.fetch(`${base}/models`, { headers: copilotHeaders(token, opts) });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Copilot /models HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as { data?: Array<{ id: string; name?: string }> };
  return {
    models: (data.data ?? []).map(toUpsertInput),
    etag: null,
    notModified: false,
  };
}

function toUpsertInput(model: { id: string; name?: string }): ProviderDiscoveredModel {
  return {
    model_id: model.id,
    name: model.name ?? model.id,
    context_window: getRegistryContextWindow(model.id),
    source: 'live',
  };
}

function readCopilotOpts(value: unknown): CopilotOAuthOptions {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const opts = value as Partial<CopilotOAuthOptions>;
    if (opts.edition === 'enterprise') {
      return {
        edition: 'enterprise',
        ghes_host: opts.ghes_host,
        integration_id: opts.integration_id,
        client_id: opts.client_id,
      };
    }
  }
  return { edition: 'individual' };
}
