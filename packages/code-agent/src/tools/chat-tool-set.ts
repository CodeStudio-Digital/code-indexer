/**
 * The chat tools a run registers. In Company: the six mailbox tools, in
 * their order. Elsewhere: the six child-chat tools, then create_chat_trigger
 * (Agêntico only, deferred), propose_task and prepare_chat_schedule. The
 * retired delegation names (spawn_agent, resume_agent, collect_agents,
 * read_agent_transcript, resume_chat) are registered nowhere; calls get the
 * replacement hint (REPLACED_BY_CHILD_CHATS, replacedInCompany). Where create_chat and stop_chat
 * would always be refused (sub-agents disabled by the admin, a read-only root
 * agent) they are not registered; talking to the parent or linked chats and
 * reading them stay.
 */
import type { CoderTool } from '../core/tool.js';
import { chatCollaborationTools } from './chat-collaboration.js';
import { childChatDeferredTools } from './child-chat-observe.js';
import { childChatDirectTools } from './child-chat-tools.js';
import { sessionNetworkTools } from './session-network.js';
import { ultraFollowupTools } from './ultra-followups.js';

const DELEGATING = new Set(['create_chat', 'stop_chat']);

/** The six tools child chats add (two direct, four deferred). */
export const CHILD_CHAT_TOOL_NAMES: ReadonlySet<string> = new Set([...childChatDirectTools, ...childChatDeferredTools].map((tool) => tool.name));

export function chatToolsForRun(input: { company: boolean; cannotDelegate?: boolean }): CoderTool[] {
  if (input.company) return [...chatCollaborationTools];
  return [
    ...[...childChatDirectTools, ...childChatDeferredTools].filter((tool) => !input.cannotDelegate || !DELEGATING.has(tool.name)),
    ...sessionNetworkTools,
    ...ultraFollowupTools,
  ];
}

/**
 * send_chat_message is direct only where someone can answer: a session that
 * can create children, a child, or an Agêntico network. Elsewhere it is
 * deferred, so it must be callable inside code_exec (no longer top-level only).
 */
export function withTalkDeferred(tool: CoderTool): CoderTool {
  return tool.name === 'send_chat_message' ? { ...tool, topLevelOnly: false } : tool;
}
