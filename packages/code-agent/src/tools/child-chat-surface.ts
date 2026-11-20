/**
 * The child-session agents switch (CODER_CHILD_SESSION_AGENTS, on by
 * default; "0" or "false" turn it off). Off: every session registers exactly
 * the tools it registered before child chats. On (outside Company):
 * delegation goes through child chats, real
 * sessions nested under the caller (create_chat, send_chat_message direct;
 * read_chat, wait_chats, stop_chat, list_chats deferred), and the tools they
 * replace are not registered. A call to a replaced name answers with its
 * replacement (the registry consults this map only for unregistered names).
 * The replaced tools' code stays until their retirement step (E7).
 */

export const CHILD_SESSION_AGENTS_FLAG = 'CODER_CHILD_SESSION_AGENTS';

/** On unless explicitly "0" or "false" (unset, empty or anything else: on). */
export function childSessionAgentsEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const raw = env[CHILD_SESSION_AGENTS_FLAG]?.trim().toLowerCase();
  return raw !== '0' && raw !== 'false';
}

/** The tool names the switch removes, and what to use instead. */
export const REPLACED_BY_CHILD_CHATS: Readonly<Record<string, string>> = {
  spawn_agent: 'Use create_chat with `title`, `prompt` (the complete task) and `profile`; wait:true (default) returns its final answer.',
  collect_agents: 'Use wait_chats with the chat ids create_chat returned, or create_chat with wait:true.',
  resume_agent: "Use send_chat_message with `to` (the child chat id) and kind:'task' to give it new work.",
  read_agent_transcript: 'Use read_chat with `chat_id` and final_only:false.',
  resume_chat: "Use send_chat_message with `to` (the child chat id) and kind:'task'.",
  reply_chat_message: 'Use send_chat_message with `reply_to` (the id of the message you answer).',
  wait_chat_response: 'Use send_chat_message with wait:true, or wait_chats for child chats.',
  cancel_chat_request: 'Use stop_chat to stop a child chat and everything it started.',
  list_project_chats: "Use list_chats with scope:'project'.",
  read_chat_messages: 'Messages to this chat arrive as turns; use read_chat to read another chat.',
};

/** Whether a tool registered today is replaced by child chats when the switch is on. */
export function isReplacedByChildChats(name: string): boolean {
  return Object.hasOwn(REPLACED_BY_CHILD_CHATS, name);
}
