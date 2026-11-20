/**
 * The chat tools a run registers. With child chats off, or in Company, it is
 * exactly the list from before child chats, in its order: the six mailbox
 * tools, then (outside Company) the network and follow-up tools. With child
 * chats on, the six child-chat tools take their place; of the old ones only
 * create_chat_trigger (Agêntico only, deferred), propose_task and
 * prepare_chat_schedule stay. The delegation tools of runCoder (spawn_agent,
 * resume_agent, collect_agents, read_agent_transcript, resume_chat) are left
 * out by runCoder itself (see REPLACED_BY_CHILD_CHATS). Where create_chat and
 * stop_chat would always be refused (sub-agents disabled by the admin, a
 * read-only root agent) they are not registered; talking to the parent or
 * linked chats and reading them stay.
 */
import type { CoderTool } from '../core/tool.js';
import { chatCollaborationTools } from './chat-collaboration.js';
import { childChatDeferredTools } from './child-chat-observe.js';
import { childChatDirectTools } from './child-chat-tools.js';
import { sessionNetworkTools } from './session-network.js';
import { ultraFollowupTools } from './ultra-followups.js';

const KEPT_WITH_CHILD_CHATS = new Set(['create_chat_trigger', 'propose_task', 'prepare_chat_schedule']);
const DELEGATING = new Set(['create_chat', 'stop_chat']);

/** The six tools child chats add (two direct, four deferred). */
export const CHILD_CHAT_TOOL_NAMES: ReadonlySet<string> = new Set([...childChatDirectTools, ...childChatDeferredTools].map((tool) => tool.name));

export function chatToolsForRun(input: { childChats: boolean; company: boolean; cannotDelegate?: boolean }): CoderTool[] {
  if (!input.childChats || input.company) {
    return [...chatCollaborationTools, ...(input.company ? [] : [...sessionNetworkTools, ...ultraFollowupTools])];
  }
  return [
    ...[...childChatDirectTools, ...childChatDeferredTools].filter((tool) => !input.cannotDelegate || !DELEGATING.has(tool.name)),
    ...[...sessionNetworkTools, ...ultraFollowupTools].filter((tool) => KEPT_WITH_CHILD_CHATS.has(tool.name)),
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

