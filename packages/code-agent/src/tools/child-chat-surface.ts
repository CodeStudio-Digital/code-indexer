/**
 * Outside Company, delegation goes through child chats, real sessions nested
 * under the caller (create_chat, send_chat_message direct; read_chat,
 * wait_chats, stop_chat, list_chats deferred), and the tools they replace are
 * not registered. A call to a replaced name answers with its replacement (the
 * registry consults this map only for unregistered names). Company never had
 * child chats and no longer has spawn_agent and its companions either: its
 * hints point to its own tools (replacedInCompany).
 */

/** The tool names child chats replace outside Company, and what to use instead. */
export const REPLACED_BY_CHILD_CHATS: Readonly<Record<string, string>> = {
  spawn_agent: 'Use create_chat with `title`, `prompt` (the complete task) and `profile`. It returns a chat id. Set wait:true if you need the final answer in this call.',
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

/**
 * The retired delegation names in Company, each with one sentence: the master
 * delegates through spawn_subordinate_agent; a subordinate does the work
 * itself, or splits it with workflow when the run has it (Ultra).
 */
export function replacedInCompany(input: { isMaster: boolean; workflow: boolean }): Readonly<Record<string, string>> {
  if (input.isMaster) return { spawn_agent: 'Use spawn_subordinate_agent to give the task to a subordinate.' };
  const orWorkflow = input.workflow ? ', or use workflow for independent steps that can run in parallel' : '';
  return {
    spawn_agent: `Do the task in this session${orWorkflow}.`,
    resume_agent: `Do the remaining work in this session${orWorkflow}.`,
    collect_agents: `No background agents run here; do the work in this session${orWorkflow}.`,
    resume_chat: `Continue the work in this session${orWorkflow}.`,
    read_agent_transcript: `No subagent transcripts are kept here; do the work in this session${orWorkflow}.`,
  };
}
