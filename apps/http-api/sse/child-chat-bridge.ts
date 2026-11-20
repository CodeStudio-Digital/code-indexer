/**
 * The app side of the worker's child-chat calls (ChildChatPort over the
 * worker bridge). Installed per session worker: every call must be made as
 * that worker's own session, so a worker never acts for another chat. A wait
 * can be cancelled by its request id (the worker's tool was aborted). No port
 * (the collaboration routes are not mounted, e.g. in Company) fails the call.
 */
import type { ChildChatPort } from '@mcp/code-agent/ports/child-chat-port.js';
import { CHILD_CHAT_BRIDGE } from '@mcp/code-agent/ports/child-chat-bridge-client.js';

interface BridgeHandlers {
  handle(type: string, handler: (payload: unknown) => unknown): () => void;
}

type Payload = Record<string, unknown> & { callerId?: unknown };

export function installChildChatBridge(bridge: BridgeHandlers, sessionId: string, port: () => ChildChatPort | null): () => void {
  const waits = new Map<string, AbortController>();
  const authorized = (payload: unknown): { port: ChildChatPort; callerId: string; payload: Payload } => {
    const body = (payload ?? {}) as Payload;
    const target = port();
    if (!target) throw new Error('Child chats are unavailable in this app process');
    if (typeof body.callerId !== 'string' || body.callerId.toLowerCase() !== sessionId.toLowerCase()) {
      throw new Error('A worker can act only as its own session');
    }
    return { port: target, callerId: body.callerId, payload: body };
  };
  const offs = [
    bridge.handle(CHILD_CHAT_BRIDGE.create, (payload) => {
      const call = authorized(payload);
      return call.port.create(call.callerId, call.payload.request as never);
    }),
    bridge.handle(CHILD_CHAT_BRIDGE.stop, (payload) => {
      const call = authorized(payload);
      return call.port.stop(call.callerId, call.payload.chatIds as string[]);
    }),
    bridge.handle(CHILD_CHAT_BRIDGE.message, (payload) => {
      const call = authorized(payload);
      return call.port.message(call.callerId, String(call.payload.chatId), call.payload.input as never);
    }),
    bridge.handle(CHILD_CHAT_BRIDGE.list, (payload) => {
      const call = authorized(payload);
      return call.port.list(call.callerId);
    }),
    bridge.handle(CHILD_CHAT_BRIDGE.wait, async (payload) => {
      const call = authorized(payload);
      const requestId = String(call.payload.requestId ?? '');
      const controller = new AbortController();
      if (requestId) waits.set(requestId, controller);
      try {
        return await call.port.wait(call.callerId, call.payload.request as never, controller.signal);
      } finally {
        if (requestId) waits.delete(requestId);
      }
    }),
    bridge.handle(CHILD_CHAT_BRIDGE.waitCancel, (payload) => {
      const requestId = String((payload as { requestId?: unknown } | null)?.requestId ?? '');
      waits.get(requestId)?.abort(new Error('the waiting tool was cancelled'));
      return { cancelled: waits.has(requestId) };
    }),
  ];
  return () => {
    for (const off of offs) off();
    for (const controller of waits.values()) controller.abort(new Error('the session worker ended'));
    waits.clear();
  };
}
