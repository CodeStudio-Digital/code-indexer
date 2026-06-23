import type { ResolvedCreds } from '../types.js';
import type { ProviderConfig } from '@mcp/store/provider-store.js';
import { getStore } from './store.js';

/**
 * Resolve AWS Bedrock credentials from the ProviderStore. Credentials
 * live in oauth_tokens.extra (populated by POST /oauth/bedrock/credentials
 * in src/apps/http-api/admin.ts). Region has a fallback in
 * provider_configs.extra.aws_region. When both are empty, returns nothing
 * and the Bedrock SDK falls back to the standard AWS credential chain
 * (EC2/ECS instance roles, ~/.aws/credentials, env vars).
 */
export function resolveBedrockCreds(cfg: ProviderConfig): ResolvedCreds {
  const store = getStore();
  const aws: NonNullable<ResolvedCreds['aws']> = {};

  if (store) {
    try {
      const tok = store.getOAuth(cfg.id);
      if (tok) {
        const extra = tok.extra as {
          accessKeyId?: string;
          secretAccessKey?: string;
          sessionToken?: string;
          region?: string;
        };
        aws.accessKeyId = extra.accessKeyId;
        aws.secretAccessKey = extra.secretAccessKey;
        aws.sessionToken = extra.sessionToken;
        aws.region = extra.region ?? (cfg.extra?.aws_region as string | undefined);
      } else {
        aws.region = cfg.extra?.aws_region as string | undefined;
      }
    } catch {
      /* fall through — AWS SDK default credential chain */
    }
  }

  return { aws };
}
