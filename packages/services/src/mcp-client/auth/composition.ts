/**
 * Composition root for outbound MCP OAuth.
 *
 * Single place that instantiates adapters and wires them into use-cases.
 * Routes and the McpServerManager receive the resulting bundle by
 * interface, never touching adapters directly.
 *
 * Reúso: primitives (Clock, RandomId, TokenHasher) são instanciados aqui
 * **separadamente** do bundle do inbound OAuth. A duplicação é
 * trivial (três new) e evita acoplamento entre os dois subsistemas — um
 * pode ser desabilitado sem afetar o outro.
 */
import { Sha256Hasher } from '../../auth/crypto/sha256-hasher.js';
import { NodeCryptoRandom } from '../../auth/runtime/node-crypto-random.js';
import { SystemClock } from '../../auth/runtime/system-clock.js';

import { SqliteMcpOAuthRegistrationRepo } from '@mcp/store/mcp-client/sqlite-oauth-registration-repo.js';
import { SqliteMcpOAuthTokensRepo } from '@mcp/store/mcp-client/sqlite-oauth-tokens-repo.js';
import { SqlitePendingAuthorizationRepo } from '@mcp/store/mcp-client/sqlite-pending-authorization-repo.js';

import { FetchDiscoveryClient } from './http/fetch-discovery-client.js';
import { FetchDcrClient } from './http/fetch-dcr-client.js';
import { FetchTokenExchangeClient } from './http/fetch-token-exchange-client.js';

import { DiscoverAuthorizationServer } from './use-cases/discover-authorization-server.js';
import { RegisterDynamicClient } from './use-cases/register-dynamic-client.js';
import { RegisterManualClient } from './use-cases/register-manual-client.js';
import { StartAuthorizationFlow } from './use-cases/start-authorization-flow.js';
import { CompleteAuthorizationFlow } from './use-cases/complete-authorization-flow.js';
import { RefreshMcpAccessToken } from './use-cases/refresh-mcp-access-token.js';
import { ResolveMcpBearer } from './use-cases/resolve-mcp-bearer.js';
import { RevokeMcpAuthorization } from './use-cases/revoke-mcp-authorization.js';

import type { McpOAuthRegistrationAdminRepo } from './ports/oauth-registration-repository.js';
import type { McpOAuthTokensReaderRepo } from './ports/oauth-tokens-repository.js';

export interface McpClientAuthBundle {
  discover: DiscoverAuthorizationServer;
  registerDynamic: RegisterDynamicClient;
  registerManual: RegisterManualClient;
  startFlow: StartAuthorizationFlow;
  completeFlow: CompleteAuthorizationFlow;
  refreshAccess: RefreshMcpAccessToken;
  resolveBearer: ResolveMcpBearer;
  revoke: RevokeMcpAuthorization;
  registrationAdminRepo: McpOAuthRegistrationAdminRepo;
  /**
   * Read-only token lookup, surfaced so the status route can report
   * whether a server has completed consent (the dashboard polls this
   * because the OAuth callback lands in an external browser and can't
   * postMessage back into the desktop window).
   */
  tokensReaderRepo: McpOAuthTokensReaderRepo;
}

export function composeMcpClientAuth(dbPath: string): McpClientAuthBundle {
  const clock = new SystemClock();
  const random = new NodeCryptoRandom();
  const hasher = new Sha256Hasher();

  const regRepo = new SqliteMcpOAuthRegistrationRepo(dbPath);
  const tokensRepo = new SqliteMcpOAuthTokensRepo(dbPath);
  const pendingRepo = new SqlitePendingAuthorizationRepo(dbPath);

  const discoveryClient = new FetchDiscoveryClient();
  const dcrClient = new FetchDcrClient();
  const tokenExchange = new FetchTokenExchangeClient();

  const discover = new DiscoverAuthorizationServer(discoveryClient);
  const registerDynamic = new RegisterDynamicClient(dcrClient, regRepo, hasher, clock);
  const registerManual = new RegisterManualClient(regRepo, hasher, clock);
  const startFlow = new StartAuthorizationFlow(regRepo, pendingRepo, random, clock);
  const completeFlow = new CompleteAuthorizationFlow(
    regRepo, pendingRepo, tokensRepo, tokenExchange, hasher, clock,
  );
  const refreshAccess = new RefreshMcpAccessToken(
    regRepo, tokensRepo, tokensRepo, tokenExchange, hasher, clock,
  );
  const resolveBearer = new ResolveMcpBearer(tokensRepo, refreshAccess, clock);
  const revoke = new RevokeMcpAuthorization(
    regRepo, regRepo, tokensRepo, tokensRepo, tokenExchange, clock,
  );

  return {
    discover,
    registerDynamic,
    registerManual,
    startFlow,
    completeFlow,
    refreshAccess,
    resolveBearer,
    revoke,
    registrationAdminRepo: regRepo,
    tokensReaderRepo: tokensRepo,
  };
}
