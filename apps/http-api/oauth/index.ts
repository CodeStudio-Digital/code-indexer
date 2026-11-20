import { HttpRouter } from '@mcp/shared/http/router.js';
import type { AuthBundle } from '../auth/composition.js';
import type { IndexerConfig } from '@mcp/shared/utils/config.js';
import { createAuthorizeRouter } from './authorize.routes.js';
import { createRegisterRouter } from './register.routes.js';
import { createRevokeRouter } from './revoke.routes.js';
import { createTokenRouter } from './token.routes.js';

/**
 * Composes the OAuth 2.1 Authorization Server endpoints under /oauth.
 * The well-known discovery endpoints are mounted separately at the app root.
 */
export function createOAuthRouter(bundle: AuthBundle, config: IndexerConfig): HttpRouter {
  const app = new HttpRouter();
  app.route('/', createAuthorizeRouter(bundle));
  app.route('/', createTokenRouter(bundle));
  app.route('/', createRevokeRouter(bundle));
  app.route('/', createRegisterRouter(bundle, config));
  return app;
}
