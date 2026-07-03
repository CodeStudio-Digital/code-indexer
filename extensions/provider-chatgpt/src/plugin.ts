import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { defineProviderAdapterFromSpec } from '@mcp/provider-runtime/plugin-adapter.js';
import { discoverChatGPTModels } from './discovery.js';
import {
  logoutChatGPTAuth,
  pollChatGPTAuth,
  resolveChatGPTCredentials,
  startChatGPTAuth,
} from './auth.js';
import { chatgptSpec } from './spec.js';

export const providerAdapter = defineProviderAdapterFromSpec(chatgptSpec, {
  authHandlers: {
    start: () => startChatGPTAuth(),
    poll: pollChatGPTAuth,
    refresh: (ctx) => resolveChatGPTCredentials(ctx),
    logout: logoutChatGPTAuth,
  },
  resolveCredentials: resolveChatGPTCredentials,
  discoverModels: discoverChatGPTModels,
});

export default definePlugin({ providers: [chatgptSpec] });
