import { createHash } from 'node:crypto';
import type { ProviderStore } from '@mcp/store/provider-store.js';
import type { EmbeddingTarget, RerankerTarget } from '@mcp/store/semantic-store.js';

type SemanticTarget = EmbeddingTarget | RerankerTarget;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entry]) => [name, canonical(entry)]),
  );
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function environmentFor(target: SemanticTarget): Record<string, string | undefined> | null {
  if (target.kind !== 'provider') return null;
  if (target.protocol === 'cloudflare') {
    return {
      CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
      CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,
    };
  }
  if (target.protocol !== 'bedrock') return null;
  // Bedrock may use the SDK default credential chain. Hash every selector or
  // credential input that can redirect that chain, but never persist it.
  return {
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
    AWS_PROFILE: process.env.AWS_PROFILE,
    AWS_REGION: process.env.AWS_REGION,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
    AWS_ROLE_ARN: process.env.AWS_ROLE_ARN,
    AWS_WEB_IDENTITY_TOKEN_FILE: process.env.AWS_WEB_IDENTITY_TOKEN_FILE,
    AWS_SHARED_CREDENTIALS_FILE: process.env.AWS_SHARED_CREDENTIALS_FILE,
    AWS_CONFIG_FILE: process.env.AWS_CONFIG_FILE,
    AWS_CONTAINER_CREDENTIALS_FULL_URI: process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI,
    AWS_EC2_METADATA_DISABLED: process.env.AWS_EC2_METADATA_DISABLED,
    AWS_SDK_LOAD_CONFIG: process.env.AWS_SDK_LOAD_CONFIG,
  };
}

function providerContext(target: SemanticTarget, providers: ProviderStore): unknown {
  if (target.kind !== 'provider') return null;
  const provider = providers.getProvider(target.providerId);
  let oauth: ReturnType<ProviderStore['getOAuth']> = null;
  try { oauth = providers.getOAuth(target.providerId); } catch { /* optional row */ }
  return {
    provider: provider && {
      id: provider.id,
      kind: provider.kind,
      base_url: provider.base_url,
      api_key: provider.api_key,
      auth_mode: provider.auth_mode,
      enabled: provider.enabled,
      extra: provider.extra,
    },
    oauth: oauth && {
      access_token: oauth.access_token,
      refresh_token: oauth.refresh_token,
      expires_at: oauth.expires_at,
      extra: oauth.extra,
    },
    environment: environmentFor(target),
  };
}

/**
 * Stable, secret-safe identity of the configured inference backend. The
 * complete target (including ONNX templates/options and local HTTP endpoint)
 * and provider auth/config/env are inputs, while only a SHA-256 digest leaves
 * this module.
 */
export function semanticTargetContextFingerprint(
  target: SemanticTarget,
  providers: ProviderStore,
): string {
  return `semantic-target:v2:${digest({
    schema: 'semantic-target-context-v2',
    target,
    provider_context: providerContext(target, providers),
  })}`;
}

/** Generation/item identity for a concrete embedding implementation. */
export function semanticEmbeddingFingerprint(
  target: EmbeddingTarget,
  providers: ProviderStore,
  serviceFingerprint: string,
): string {
  return `semantic-embedding:v2:${digest({
    schema: 'semantic-embedding-space-v2',
    target_context: semanticTargetContextFingerprint(target, providers),
    service_fingerprint: serviceFingerprint,
  })}`;
}
