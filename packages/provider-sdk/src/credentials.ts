/**
 * Credential shapes shared by the provider adapter contract and the auth
 * contract. Extracted into their own module so `auth.ts` and `provider.ts` can
 * both reference them without importing each other (no cycle).
 */

export type CredKind = 'api-key' | 'oauth' | 'aws';

export interface ResolvedCreds {
  apiKey?: string;
  /** Bearer token auth used by OAuth-backed Anthropic/Claude Code flows. */
  authToken?: string;
  baseURL?: string;
  extraHeaders?: Record<string, string>;
  /** Optional provider-specific fetch implementation (proxy/retry/auth parity). */
  fetch?: typeof fetch;
  aws?: {
    apiKey?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    region?: string;
  };
  /** OAuth-specific scratch (accountId for ChatGPT, editor opts for Copilot). */
  extra?: Record<string, unknown>;
}

/**
 * Structural view of a stored provider instance row. A subset of the store's
 * `ProviderConfig`, declared here so the SDK contract stays a leaf (no
 * dependency on `@mcp/store`). The real `ProviderConfig` satisfies it.
 */
export interface ProviderConfigLike {
  id: string;
  kind: string;
  name?: string;
  base_url?: string | null;
  api_key?: string | null;
  extra?: Record<string, unknown> | null;
}

export interface ProviderStoredSecretLike {
  extra?: Record<string, unknown> | null;
}

export interface ProviderSecretReaderLike {
  get(): Promise<ProviderStoredSecretLike | null>;
}

/**
 * Generic API-key resolver for provider plugins. The host still owns encrypted
 * persistence; the plugin owns how its config row maps to runtime credentials.
 */
export function resolveApiKeyConfigCredentials(
  config: ProviderConfigLike,
  defaultBaseURL?: string,
): ResolvedCreds {
  return {
    apiKey: config.api_key ?? undefined,
    baseURL: config.base_url ?? defaultBaseURL,
    extra: config.extra ?? undefined,
  };
}

/**
 * Generic AWS/SigV4 resolver for provider plugins. Reads the provider-owned
 * secret blob through the SDK credential store and falls back to config.extra
 * for region so SDK clients can still use the default AWS credential chain.
 */
export async function resolveAwsConfigCredentials(
  config: ProviderConfigLike,
  credentials: ProviderSecretReaderLike,
): Promise<ResolvedCreds> {
  const tokens = await credentials.get();
  return { aws: readBedrockCredentials(tokens?.extra, config.extra?.aws_region) };
}

export function readBedrockCredentials(
  secret?: Record<string, unknown> | null,
  region?: unknown,
): NonNullable<ResolvedCreds['aws']> {
  return {
    apiKey: readString(secret?.bedrockApiKey),
    accessKeyId: readString(secret?.accessKeyId),
    secretAccessKey: readString(secret?.secretAccessKey),
    sessionToken: readString(secret?.sessionToken),
    region: readString(secret?.region) ?? readString(secret?.aws_region) ?? readString(region),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Shared AWS SDK options for Bedrock control-plane and Converse clients. */
export function bedrockClientConfig(aws: ResolvedCreds['aws'] = {}) {
  const region = aws.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
  if (aws.apiKey) {
    return { region, token: { token: aws.apiKey }, authSchemePreference: ['httpBearerAuth'] };
  }
  if (aws.accessKeyId && aws.secretAccessKey) {
    return {
      region,
      credentials: { accessKeyId: aws.accessKeyId, secretAccessKey: aws.secretAccessKey, sessionToken: aws.sessionToken },
      authSchemePreference: ['sigv4'],
    };
  }
  return { region };
}
