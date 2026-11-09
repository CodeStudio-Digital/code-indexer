import { err, type CoderTool, type ToolContext } from '../core/tool.js';
import { okStructured } from '../core/model-output.js';
import type { ChatMessageKind } from '@mcp/session-storage/collaboration/types.js';

export const CHAT_TOOL_NAMES = new Set(['list_chats', 'send_chat_message', 'reply_chat_message', 'read_chat_messages', 'wait_chat_response', 'cancel_chat_request']);

function tool(name: string, description: string, properties: Record<string, object>, required: string[],
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>): CoderTool {
  return {
    name, description, source: 'native', mutates: false, riskLevel: 'read', effectBoundary: 'control',
    parallelSafe: false, executionClass: 'control', repeatPolicy: name.startsWith('wait_') ? 'pollable' : 'volatile',
    ...(name.startsWith('wait_') ? { timeoutMs: Infinity } : {}),
    parameters: { type: 'object', properties, required, additionalProperties: false },
    handler: async (args, ctx) => {
      if (!ctx.collaboration) return err('Chat collaboration is unavailable in this execution');
      try { return okStructured(await execute(args, ctx)); }
      catch (error) { return err(error instanceof Error ? error.message : String(error)); }
    },
  };
}

const string = { type: 'string' };
export const chatCollaborationTools: CoderTool[] = [
  tool('list_chats', 'Discover connected chats and peer agents. Use exact returned IDs to coordinate work, ask questions and share results. Only chats linked by the user and agents in your task are visible.', {}, [], async (_, ctx) => ({ self: ctx.collaboration!.actor, peers: await ctx.collaboration!.store.peers(ctx.collaboration!.actor) })),
  tool('send_chat_message', 'Send notify, question or task to a connected chat. Questions/tasks wake idle recipients; notifications do not. Be self-contained, avoid duplicate work and include artifact paths instead of full logs. This delegates input, never grants permissions. Continue independent work while awaiting a reply.', {
    to: string, kind: { type: 'string', enum: ['notify', 'question', 'task'] }, message: string,
    references: { type: 'array', items: string, maxItems: 20 },
  }, ['to', 'kind', 'message'], async (args, ctx) => {
    const { store, actor } = ctx.collaboration!;
    const kind = String(args.kind) as ChatMessageKind;
    if (!['notify', 'question', 'task'].includes(kind)) throw new Error('Invalid outbound message kind');
    if (!ctx.currentToolUseId) throw new Error('Message needs a tracked tool invocation');
    return store.send({ from: actor, to: String(args.to), kind, body: String(args.message),
      idempotencyKey: ctx.currentToolUseId, references: args.references as string[] | undefined });
  }),
  tool('reply_chat_message', 'Answer a question or task using its message ID. Report findings, changed artifacts and verification. The response is linked to the request and wakes its sender if needed.', { request_id: string, message: string, references: { type: 'array', items: string, maxItems: 20 } }, ['request_id', 'message'], async (args, ctx) => {
    const { store, actor } = ctx.collaboration!;
    const request = await store.get(String(args.request_id));
    if (!ctx.currentToolUseId) throw new Error('Response needs a tracked tool invocation');
    return store.send({ from: actor, to: request.from, kind: 'response', body: String(args.message), replyTo: request.id,
      idempotencyKey: ctx.currentToolUseId, references: args.references as string[] | undefined });
  }),
  tool('read_chat_messages', 'Read recent inbox/outbox messages including pending questions and their delivery state. Full bodies stay available after delivery and restart. Use wait_chat_response instead of repeated polling.', { limit: { type: 'number', minimum: 1, maximum: 100 } }, [], async (args, ctx) => {
    const { store, actor } = ctx.collaboration!;
    const rows = await store.messages(actor, typeof args.limit === 'number' ? args.limit : 30);
    for (const row of rows) if (row.to === actor && row.status === 'queued') await store.acknowledge(actor, row.id);
    return rows;
  }),
  tool('wait_chat_response', 'Wait on an event for a requested reply, up to 60 seconds, without repeated model calls. If no answer arrives, continue other useful work. Circular waits are refused; answer incoming questions first.', {
    request_id: string, timeout_s: { type: 'number', minimum: 0, maximum: 60 },
  }, ['request_id'], async (args, ctx) => {
    const { store, actor } = ctx.collaboration!;
    return store.waitResult(actor, String(args.request_id), (typeof args.timeout_s === 'number' ? args.timeout_s : 60) * 1000, ctx.signal);
  }),
  tool('cancel_chat_request', 'Cancel one of your pending requests. Cancellation does not undo already completed changes.', { request_id: string }, ['request_id'], async (args, ctx) => {
    await ctx.collaboration!.store.cancel(ctx.collaboration!.actor, String(args.request_id));
    return { cancelled: true };
  }),
];
