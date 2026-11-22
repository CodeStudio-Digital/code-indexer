import { statSync } from 'node:fs';
import { join } from 'node:path';
import { assertPathHasNoLinksSync } from '../path-safety.js';
import { readConversationSync } from '../session-writer.js';
import type { SessionLocation } from '../types.js';
import { projectConversation } from './conversation-codec.js';
import type { FsStoredMessage } from './types.js';

function summarize(path: string) {
  const { storedMessages, toolCalls } = projectConversation(readConversationSync(path));
  let latest: FsStoredMessage['usage'] | undefined;
  let assistantTurns = 0;
  for (const { role, usage } of storedMessages) {
    if (role !== 'assistant') continue;
    assistantTurns++;
    if (usage.context || usage.input_tokens > 0 || usage.cache_read_tokens > 0 || usage.cache_creation_tokens > 0) {
      latest = usage;
    }
  }
  return {
    latest,
    message_count: storedMessages.length,
    assistant_turns: assistantTurns,
    tool_call_count: toolCalls.length,
    tool_error_count: toolCalls.filter(tool => tool.is_error).length,
    distinct_tools: new Set(toolCalls.map(tool => tool.tool_name)).size,
    subagent_call_count: toolCalls.filter(tool => ['spawn_agent', 'spawn_subagent', 'spawn_agents'].includes(tool.tool_name)).length,
    total_tool_duration_ms: toolCalls.reduce((total, tool) => total + tool.duration_ms, 0),
  };
}

export type ConversationStats = ReturnType<typeof summarize>;
export type ReadConversationStats = (location: SessionLocation) => ConversationStats | Promise<ConversationStats>;

/** The desktop owns one reader on a worker. Only counts and the latest usage survive a read. */
export class ConversationStatsReader {
  private readonly cache = new Map<string, { version: string; summary: ConversationStats }>();

  read = (location: SessionLocation): ConversationStats => {
    const path = join(location.bundle_path, 'conversation.jsonl');
    assertPathHasNoLinksSync(location.session_root, path);
    const file = statSync(path, { bigint: true });
    const version = `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
    const existing = this.cache.get(path);
    const summary = existing?.version === version ? existing.summary : summarize(path);
    this.cache.delete(path);
    this.cache.set(path, { version, summary });
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    return summary;
  };
}
