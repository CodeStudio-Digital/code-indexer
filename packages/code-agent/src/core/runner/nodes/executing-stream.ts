/**
 * Stream consumer — pure accumulator over `AsyncIterable<ChatDelta>`.
 *
 * The provider emits a flat stream of delta events (text chunks, tool-use
 * boundaries, usage, done). This function buckets them into the structured
 * shape the Executing node needs: text blocks, tool_use blocks (with their
 * final input objects), usage, stop reason.
 *
 * Side effects are limited to the optional `onTextDelta` / `onThinkingDelta` /
 * `onToolCallStart` callbacks — used by the runner to stream live progress
 * to the dashboard/CLI without coupling stream consumption to event
 * emission.
 *
 * Does NOT mutate any caller state.
 */
import type { ChatDelta, ChatUsage } from '@mcp/code-agent/core/messages.js';

export interface ToolUseAccumulated {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Raw partial_json fragments collected while streaming. */
  partialJson: string[];
}

export interface StreamResult {
  textBlocks: string[];
  toolUses: ToolUseAccumulated[];
  thinkingBlocks: string[];
  usage: ChatUsage | null;
  stopReason: string;
  /** Server-side response id (Codex / ChatGPT only). */
  responseId: string | null;
  /** Companion to `responseId` — message count at the time of emit. */
  responseMessageCount: number | null;
}

export interface ConsumeStreamArgs {
  stream: AsyncIterable<ChatDelta>;
  signal?: AbortSignal;
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onToolCallStart?: (id: string, name: string) => void;
}

export async function consumeStream(args: ConsumeStreamArgs): Promise<StreamResult> {
  const textBlocks: string[] = [];
  const thinkingBlocks: string[] = [];
  const toolUses: ToolUseAccumulated[] = [];
  const toolUsesById = new Map<string, ToolUseAccumulated>();
  let currentText = '';
  let currentThinking = '';
  let usage: ChatUsage | null = null;
  let stopReason = 'unknown';
  let responseId: string | null = null;
  let responseMessageCount: number | null = null;

  for await (const delta of args.stream) {
    if (args.signal?.aborted) break;

    switch (delta.type) {
      case 'text_delta':
        currentText += delta.text;
        args.onTextDelta?.(delta.text);
        break;

      case 'thinking_delta':
        currentThinking += delta.text;
        args.onThinkingDelta?.(delta.text);
        break;

      case 'tool_call_start': {
        // Flush any accumulated text BEFORE this tool_use boundary —
        // well-formed streams emit `[text, tool_use, text?, ...]`.
        if (currentText) {
          textBlocks.push(currentText);
          currentText = '';
        }
        const tu: ToolUseAccumulated = {
          id: delta.id,
          name: delta.name,
          input: {},
          partialJson: [],
        };
        toolUsesById.set(delta.id, tu);
        toolUses.push(tu);
        args.onToolCallStart?.(delta.id, delta.name);
        break;
      }

      case 'tool_call_args': {
        const tu = toolUsesById.get(delta.id);
        if (tu) tu.partialJson.push(delta.partial_json);
        break;
      }

      case 'tool_call_end': {
        const tu = toolUsesById.get(delta.id);
        if (tu) {
          tu.input = delta.input ?? tu.input;
        }
        break;
      }

      case 'usage':
        usage = delta.usage;
        break;

      case 'response_id':
        responseId = delta.id;
        responseMessageCount = delta.messageCount;
        break;

      case 'done':
        stopReason = delta.stop_reason ?? 'unknown';
        break;

      // 'response_meta' and 'image_generated' currently ignored — the
      // Executing minimal scope doesn't synthesize ImageBlocks yet.
    }
  }

  // Flush trailing buffers in case the stream ended without an explicit
  // boundary (some providers don't emit `done` cleanly).
  if (currentText) textBlocks.push(currentText);
  if (currentThinking) thinkingBlocks.push(currentThinking);

  return { textBlocks, toolUses, thinkingBlocks, usage, stopReason, responseId, responseMessageCount };
}
