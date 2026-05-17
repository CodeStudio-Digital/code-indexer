/**
 * Composition root for the auth subsystem.
 *
 * The ONLY place in the codebase that instantiates adapters and wires them
 * into use-cases. Routes and middleware depend on the returned bundle, not
 * on concrete classes — preserving the dependency rule of Clean Architecture.
 */
import { Sha256Hasher } from '@mcp/services/auth/crypto/sha256-hasher.js';
import { HmacJwtSigner } from '@mcp/services/auth/crypto/hmac-jwt-signer.js';
import { NodeCryptoRandom } from '@mcp/services/auth/runtime/node-crypto-random.js';
import { SystemClock } from '@mcp/services/auth/runtime/system-clock.js';
import { MemoryRateLimiter } from '@mcp/services/auth/runtime/memory-rate-limiter.js';

import { SqliteApiTokenRepo } from '@mcp/store/auth/sqlite-api-token-repo.js';
import { SqliteOAuthClientRepo } from '@mcp/store/auth/sqlite-oauth-client-repo.js';
import { SqliteAuthCodeRepo } from '@mcp/store/auth/sqlite-auth-code-repo.js';
import { SqliteRefreshTokenRepo } from '@mcp/store/auth/sqlite-refresh-token-repo.js';
import { SqliteAuditLogRepo } from '@mcp/store/auth/sqlite-audit-log-repo.js';

import { ValidateBearerToken } from '@mcp/services/auth/use-cases/validate-bearer-token.js';
import { EnforceScope } from '@mcp/services/auth/use-cases/enforce-scope.js';
import { EnforceRateLimit } from '@mcp/services/auth/use-cases/enforce-rate-limit.js';
import { RecordAudit } from '@mcp/services/auth/use-cases/record-audit.js';
import { IssueApiToken } from '@mcp/services/auth/use-cases/issue-api-token.js';
import { ListApiTokens } from '@mcp/services/auth/use-cases/list-api-tokens.js';
import { RevokeApiToken } from '@mcp/services/auth/use-cases/revoke-api-token.js';
import { RegisterOAuthClient } from '@mcp/services/auth/use-cases/register-oauth-client.js';
import { ListOAuthClients } from '@mcp/services/auth/use-cases/list-oauth-clients.js';
import { RevokeOAuthClient } from '@mcp/services/auth/use-cases/revoke-oauth-client.js';
import { StartAuthorization } from '@mcp/services/auth/use-cases/start-authorization.js';
import { ExchangeAuthorizationCode } from '@mcp/services/auth/use-cases/exchange-authorization-code.js';
import { RefreshAccessToken } from '@mcp/services/auth/use-cases/refresh-access-token.js';
import { RevokeOAuthToken } from '@mcp/services/auth/use-cases/revoke-oauth-token.js';

import type { IndexerConfig } from '@mcp/shared/utils/config.js';

export interface AuthBundle {
  // Middleware-facing
  validate: ValidateBearerToken;
  enforceScope: EnforceScope;
  enforceRate: EnforceRateLimit;
  audit: RecordAudit;
  // API token admin
  issueApiToken: IssueApiToken;
  listApiTokens: ListApiTokens;
  revokeApiToken: RevokeApiToken;
  // OAuth admin + flow
  registerOAuthClient: RegisterOAuthClient;
  listOAuthClients: ListOAuthClients;
  revokeOAuthClient: RevokeOAuthClient;
  startAuthorization: StartAuthorization;
  exchangeCode: ExchangeAuthorizationCode;
  refreshAccess: RefreshAccessToken;
  revokeOAuthToken: RevokeOAuthToken;
  // Runtime
  newRequestId: () => string;
}

export function composeAuth(config: IndexerConfig): AuthBundle {
  const clock = new SystemClock();
  const random = new NodeCryptoRandom();
  const hasher = new Sha256Hasher();
  const rateLimiter = new MemoryRateLimiter(clock);

  // JWT signer is optional at this stage: OAuth-only code paths require it,
  // but API-token-only deployments don't. A placeholder secret is used when
  // OAuth is disabled; the signer still validates its minimum length.
  const jwtSecret = config.mcp.oauth.enabled
    ? config.mcp.oauth.jwtSecret
    : 'disabled-oauth-signer-placeholder-secret-32b'; // ≥32 chars
  if (config.mcp.oauth.enabled && (!config.mcp.oauth.jwtSecret || config.mcp.oauth.jwtSecret.length < 32)) {
    throw new Error(
      'MCP_OAUTH_JWT_SECRET must be set (>=32 chars) when MCP_OAUTH_ENABLED=true',
    );
  }
  const signer = new HmacJwtSigner(jwtSecret, clock);

  const apiTokenRepo = new SqliteApiTokenRepo(config.dbPath);
  const clientRepo = new SqliteOAuthClientRepo(config.dbPath);
  const codeRepo = new SqliteAuthCodeRepo(config.dbPath);
  const refreshRepo = new SqliteRefreshTokenRepo(config.dbPath);
  const auditRepo = new SqliteAuditLogRepo(config.dbPath);

  const exchangeConfig = {
    issuer: config.mcp.oauth.issuer || 'mcp',
    audience: 'mcp',
    accessTtlSec: config.mcp.oauth.accessTtlSec,
    refreshTtlSec: config.mcp.oauth.refreshTtlSec,
  };

  return {
    validate: new ValidateBearerToken(apiTokenRepo, signer, hasher, clock),
    enforceScope: new EnforceScope(),
    enforceRate: new EnforceRateLimit(rateLimiter, config.mcp.auth.rateLimitPerMin),
    audit: new RecordAudit(auditRepo, clock),

    issueApiToken: new IssueApiToken(apiTokenRepo, hasher, random, clock),
    listApiTokens: new ListApiTokens(apiTokenRepo),
    revokeApiToken: new RevokeApiToken(apiTokenRepo, clock),

    registerOAuthClient: new RegisterOAuthClient(clientRepo, random, hasher, clock),
    listOAuthClients: new ListOAuthClients(clientRepo),
    revokeOAuthClient: new RevokeOAuthClient(clientRepo, clock),
    startAuthorization: new StartAuthorization(clientRepo, codeRepo, random, clock),
    exchangeCode: new ExchangeAuthorizationCode(
      clientRepo, codeRepo, refreshRepo, signer, hasher, random, clock, exchangeConfig,
    ),
    refreshAccess: new RefreshAccessToken(
      refreshRepo, signer, hasher, random, clock, exchangeConfig,
    ),
    revokeOAuthToken: new RevokeOAuthToken(refreshRepo, hasher, clock),

    newRequestId: () => random.uuid(),
  };
}
