/**
 * The worker side of ChildChatPort: each call is a request over the worker's
 * bridge to the app, like the other worker-to-app calls (preview, research
 * browser), with its own deadline. A wait has the long deadline and can be
 * cancelled: aborting its signal sends a cancel request for it. Errors come
 * back as the app's message.
 */
import { randomUUID } from 'node:crypto';
import { CHILD_AGENT_WAIT_TOOL_TIMEOUT_MS } from './child-agent-port.js';
import type { ChildChatPort } from './child-chat-port.js';

export interface ChildChatBridge {
  request<T = unknown>(type: string, payload: unknown, opts?: { timeoutMs?: number }): Promise<T>;
}

/** Short calls: creating, stopping, messaging and listing never wait for a run. */
const SHORT_MS = 60_000;

export const CHILD_CHAT_BRIDGE = {
  create: 'childChat.create',
  wait: 'childChat.wait',
  waitCancel: 'childChat.waitCancel',
  stop: 'childChat.stop',
  message: 'childChat.message',
  list: 'childChat.list',
} as const;

export function createChildChatBridgeClient(bridge: ChildChatBridge): ChildChatPort {
  return {
    create: (callerId, request) => bridge.request(CHILD_CHAT_BRIDGE.create, { callerId, request }, { timeoutMs: SHORT_MS }),
    stop: (callerId, chatIds) => bridge.request(CHILD_CHAT_BRIDGE.stop, { callerId, chatIds: [...chatIds] }, { timeoutMs: SHORT_MS }),
    message: (callerId, chatId, input) => bridge.request(CHILD_CHAT_BRIDGE.message, { callerId, chatId, input }, { timeoutMs: SHORT_MS }),
    list: (callerId) => bridge.request(CHILD_CHAT_BRIDGE.list, { callerId }, { timeoutMs: SHORT_MS }),
    async wait(callerId, request, signal) {
      const requestId = randomUUID();
      const cancel = () => { void bridge.request(CHILD_CHAT_BRIDGE.waitCancel, { requestId }, { timeoutMs: 2_000 }).catch(() => undefined); };
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
      try {
        return await bridge.request(CHILD_CHAT_BRIDGE.wait, { callerId, request, requestId }, { timeoutMs: CHILD_AGENT_WAIT_TOOL_TIMEOUT_MS });
      } finally {
        signal?.removeEventListener('abort', cancel);
      }
    },
  };
}
