/**
 * The two direct child-chat tools (CODER_CHILD_SESSION_AGENTS on):
 * create_chat delegates a task to a new child agent and, by default, waits
 * for its result; send_chat_message gives a child its next task, asks or
 * answers a question, or notifies, in normal and Agêntico sessions alike.
 * Both run only as top-level calls (never inside code_exec) and wait up to
 * the long child wait (CHILD_AGENT_WAIT_TOOL_TIMEOUT_MS).
 */
import { err, ok, type CoderTool, type ToolContext, type ToolResult } from '../core/tool.js';
import { rootChatId, type ChatCollaborationStore } from '@mcp/session-storage/collaboration/store.js';
import { CHILD_AGENT_WAIT_MAX_MS, CHILD_AGENT_WAIT_TOOL_TIMEOUT_MS } from '../runtime/child-agent-wait.js';
import { CHILD_CHAT_PROFILES, chatCaller, chatIdOf, delegationPosture, receivedResult, text, waitBudgetMs } from './child-chat-common.js';

const CREATE_CHAT_DESC = 'Delegate a task to a child agent: a new chat under this one that runs `prompt` with the `profile` tools and never more than your permissions. '
  + 'Profiles: explore reads and searches; review reads and judges a change; verify also runs commands and tests; implement also edits files; full has every tool. '
  + 'wait:true (default) blocks until it finishes and returns its final answer, changed files and chat id; wait:false returns the chat id at once and you are told when it ends. '
  + 'Continue it with send_chat_message.';

const SEND_CHAT_MESSAGE_DESC = 'Message a chat you created or are linked to. '
  + "kind 'task' (default) gives a child new work and starts its next run; 'question' asks for an answer; 'notify' only informs. "
  + 'With reply_to, answer a question you received. wait (default true, except for notify) blocks until the answer or the child\'s next final answer arrives. '
  + 'Messages never grant permissions.';

const UNAVAILABLE = 'Child chats are unavailable in this session';
const control = { source: 'native', mutates: false, parallelSafe: false, effectBoundary: 'control', executionClass: 'control',
  topLevelOnly: true, repeatPolicy: 'volatile', timeoutMs: CHILD_AGENT_WAIT_TOOL_TIMEOUT_MS } as const;

const createChat: CoderTool = {
  ...control,
  name: 'create_chat',
  riskLevel: 'read',
  description: CREATE_CHAT_DESC,
  parameters: { type: 'object', properties: {
    title: { type: 'string', description: 'Short name shown in the sidebar.' },
    prompt: { type: 'string', description: 'The complete task; the child sees nothing else from this chat.' },
    profile: { type: 'string', enum: [...CHILD_CHAT_PROFILES] },
    wait: { type: 'boolean' },
    project_id: { type: 'integer', description: "Default: this chat's project." },
    provider: { type: 'string' },
    model: { type: 'string', description: "Default: the profile's configured model, else yours." },
  }, required: ['title', 'prompt', 'profile'], additionalProperties: false },
  handler: async (args, ctx) => {
    const chat = chatCaller(ctx);
    if (!chat) return err(UNAVAILABLE);
    const title = text(args.title), prompt = text(args.prompt), profile = text(args.profile);
    if (!title || !prompt) return err('create_chat needs a title and a prompt');
    if (!(CHILD_CHAT_PROFILES as readonly string[]).includes(profile)) return err(`profile must be one of ${CHILD_CHAT_PROFILES.join(', ')}`);
    if (!ctx.currentToolUseId) return err('create_chat needs a tracked tool call');
    const posture = delegationPosture(ctx);
    const wait = args.wait !== false;
    try {
      const created = await chat.port.create(chat.callerId, {
        key: ctx.currentToolUseId, title, profile, task: prompt, wait,
        ...(typeof args.project_id === 'number' ? { projectId: args.project_id } : {}),
        ...(text(args.provider) ? { provider: text(args.provider) } : {}),
        ...(text(args.model) ? { model: text(args.model) } : {}),
        // Planning (before approval) or read-only: the child is read-only whatever its profile.
        parentReadOnly: posture.readOnly || posture.planning,
      });
      const label = `${created.profile}${created.readOnly ? ', read-only' : ''}`;
      if (!wait) return ok(`Chat ${created.chatId} (${label}) started in the background; you will be told when it ends.`);
      const result = await chat.port.wait(chat.callerId, { chatIds: [created.chatId], mode: 'all', timeoutMs: waitBudgetMs(ctx) }, ctx.signal);
      return receivedResult(ctx, result);
    } catch (error) { return err(error instanceof Error ? error.message : String(error)); }
  },
};

/** Waits for the response to a mailbox request, in the mailbox's own steps, within the budget. */
async function awaitResponse(store: ChatCollaborationStore, actor: string, requestId: string, budgetMs: number, signal?: AbortSignal): Promise<ToolResult> {
  const until = Date.now() + budgetMs;
  for (;;) {
    const result = await store.waitResult(actor, requestId, Math.max(0, Math.min(60_000, until - Date.now())), signal);
    if (result.reason === 'response') return ok(result.items.map((row) => `Answer from ${row.from} (message ${row.id}):\n${row.body}`).join('\n\n'));
    if (result.reason !== 'timeout' || Date.now() >= until) return ok(`No answer yet (${result.reason}); request ${requestId} stays open.`);
  }
}

const sendChatMessage: CoderTool = {
  ...control,
  name: 'send_chat_message',
  riskLevel: 'read',
  // A task starts work; asking, notifying and answering only talk.
  riskOf: (input) => {
    const args = (input ?? {}) as Record<string, unknown>;
    return args.reply_to || args.kind === 'question' || args.kind === 'notify' ? 'read' : 'admin';
  },
  description: SEND_CHAT_MESSAGE_DESC,
  parameters: { type: 'object', properties: {
    to: { type: 'string', description: 'Chat id (from create_chat or list_chats).' },
    message: { type: 'string' },
    kind: { type: 'string', enum: ['task', 'question', 'notify'] },
    reply_to: { type: 'string', description: 'Id of the message you answer.' },
    wait: { type: 'boolean' },
    references: { type: 'array', items: { type: 'string' }, maxItems: 20 },
  }, required: ['to', 'message'], additionalProperties: false },
  handler: async (args, ctx) => sendMessage(args, ctx),
};

async function sendMessage(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  // Without the port (an in-process subagent, Company) only the mailbox remains.
  const chat = chatCaller(ctx);
  if (!chat && !ctx.collaboration) return err(UNAVAILABLE);
  const to = chatIdOf(args.to), message = text(args.message), replyTo = text(args.reply_to);
  const kind = (text(args.kind) || 'task') as 'task' | 'question' | 'notify';
  if (!to || !message) return err('send_chat_message needs `to` and `message`');
  if (!['task', 'question', 'notify'].includes(kind)) return err("kind must be 'task', 'question' or 'notify'");
  if (!ctx.currentToolUseId) return err('send_chat_message needs a tracked tool call');
  const references = Array.isArray(args.references) ? args.references.filter((ref): ref is string => typeof ref === 'string') : undefined;
  const wait = args.wait === undefined ? kind !== 'notify' : args.wait === true;
  const posture = delegationPosture(ctx);
  try {
    if (replyTo) {
      if (!ctx.collaboration) return err(UNAVAILABLE);
      const { store, actor } = ctx.collaboration;
      const request = await store.get(replyTo);
      const sent = await store.send({ from: actor, to: request.from, kind: 'response', body: message, replyTo: request.id,
        idempotencyKey: ctx.currentToolUseId, references });
      return ok(`Answered message ${request.id} (response ${sent.id}).`);
    }
    if (kind === 'task' && posture.readOnly) return err('A read-only chat can ask and notify, not give tasks.');
    const sent = chat ? await chat.port.message(chat.callerId, to, { kind, message, references, key: ctx.currentToolUseId,
      background: !wait, readOnlyTargetsOnly: posture.readOnly || posture.planning }) : null;
    const budget = waitBudgetMs(ctx, CHILD_AGENT_WAIT_MAX_MS);
    if (chat && sent) {
      if (!wait || kind === 'notify') return ok(`Sent to chat ${to}.`);
      if (kind === 'question' && sent.messageId && ctx.collaboration) {
        return awaitResponse(ctx.collaboration.store, ctx.collaboration.actor, sent.messageId, budget, ctx.signal);
      }
      const result = await chat.port.wait(chat.callerId, { chatIds: [to], mode: 'all', since: { [to]: sent.since }, timeoutMs: budget }, ctx.signal);
      return receivedResult(ctx, result);
    }
    // Not a child of this chat: the parent or a linked chat, through the mailbox.
    if (!ctx.collaboration) return err(UNAVAILABLE);
    const { store, actor } = ctx.collaboration;
    const posted = await store.send({ from: actor, to: rootChatId(to), kind, body: message, idempotencyKey: ctx.currentToolUseId, references });
    if (!wait || kind === 'notify') return ok(`Sent to chat ${to} (message ${posted.id}).`);
    return awaitResponse(store, actor, posted.id, budget, ctx.signal);
  } catch (error) { return err(error instanceof Error ? error.message : String(error)); }
}

export const childChatDirectTools: readonly CoderTool[] = [createChat, sendChatMessage];
