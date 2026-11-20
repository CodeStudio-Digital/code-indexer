/**
 * The durable conclusion of a child-agent run, built by the run itself when it
 * ends: its state, its full final answer (the salvage summary when cut off),
 * the files it changed and its usage. A parent waiting again after a restart
 * reads it instead of re-running anything (E4b adds the usage roll-up and the
 * parent's overlay invalidation from the same record).
 */
import type { FsChildAgentConclusion } from '@mcp/session-storage/fs-store/index.js';
import type { AgentMessage, ChatUsage } from '../core/messages.js';
import type { ToolContext } from '../core/tool.js';

/** Bound on the answer kept in state.json; the transcript still has all of it. */
export const CHILD_AGENT_CONCLUSION_TEXT_MAX = 200_000;

type MessageListener = (message: AgentMessage, usage?: ChatUsage | null) => void;

/**
 * Follows the runner's assistant messages: keeps the last final answer and
 * adds up the usage of the committed ones, which is what a run that threw
 * (instead of ending with its own total) has recorded as spent.
 */
export function trackFinalAnswer(runner: {
  on(event: 'message_complete', listener: MessageListener): unknown;
  off(event: 'message_complete', listener: MessageListener): unknown;
}): { text(): string | null; usage(): ChatUsage; stop(): void } {
  let last: string | null = null;
  const spent = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const listener: MessageListener = (message, usage) => {
    if (usage) {
      spent.input_tokens += usage.input_tokens ?? 0;
      spent.output_tokens += usage.output_tokens ?? 0;
      spent.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
      spent.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
    }
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return;
    if (message.content.some((block) => block.type === 'tool_use')) return;
    const text = message.content.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text).join('\n').trim();
    if (text) last = text;
  };
  runner.on('message_complete', listener);
  return { text: () => last, usage: () => ({ ...spent }), stop: () => runner.off('message_complete', listener) };
}

/** The workspace files with pending changes from this run (snapshot baselines). */
export async function changedFiles(toolContext: Pick<ToolContext, 'sessionChanges'>): Promise<string[]> {
  try {
    const diffs = await toolContext.sessionChanges?.getDiffs() ?? [];
    return [...new Set(diffs.map((diff) => diff.baseline.filePath))].sort();
  } catch {
    return []; // best effort: the answer and the state still conclude the run
  }
}

export function conclusionState(input: { cutoff: string | null; violation: string | null; reason: string }): FsChildAgentConclusion['state'] {
  if (input.cutoff) return 'cut_off';
  if (input.violation) return 'failed';
  if (input.reason === 'completed') return 'completed';
  if (input.reason === 'aborted') return 'aborted';
  return 'failed';
}

export function buildConclusion(input: {
  runId: string;
  state: FsChildAgentConclusion['state'];
  reason: string;
  finalText: string | null;
  changedFiles: string[];
  usage: ChatUsage;
  now?: Date;
}): FsChildAgentConclusion {
  return {
    run_id: input.runId,
    state: input.state,
    reason: input.reason,
    finished_at: (input.now ?? new Date()).toISOString(),
    final_text: input.finalText ? input.finalText.slice(0, CHILD_AGENT_CONCLUSION_TEXT_MAX) : null,
    changed_files: input.changedFiles,
    usage: {
      input_tokens: input.usage.input_tokens,
      output_tokens: input.usage.output_tokens,
      cache_read_input_tokens: input.usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: input.usage.cache_creation_input_tokens ?? 0,
    },
  };
}
