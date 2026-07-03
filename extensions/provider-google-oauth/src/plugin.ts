import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { defineProviderAdapterFromSpec } from '@mcp/provider-runtime/plugin-adapter.js';
import {
  logoutGoogleOAuth,
  pollGoogleOAuth,
  resolveGoogleOAuthCredentials,
  startGoogleOAuth,
} from './auth.js';
import { discoverGoogleOAuthModels } from './discovery.js';
import { googleOAuthSpec } from './spec.js';

export const providerAdapter = defineProviderAdapterFromSpec(googleOAuthSpec, {
  authHandlers: {
    start: () => startGoogleOAuth(),
    poll: pollGoogleOAuth,
    refresh: (ctx) => resolveGoogleOAuthCredentials(ctx),
    logout: logoutGoogleOAuth,
  },
  resolveCredentials: resolveGoogleOAuthCredentials,
  discoverModels: discoverGoogleOAuthModels,
});

export default definePlugin({ providers: [googleOAuthSpec] });
