import type { AgentMessage } from '@mcp/provider-sdk';
import { clipMiddle, safeJson } from './summary-limits.js';

const DEFAULT_INPUT_BUDGET = 120_000;

const HEAD_COUNT = 10;

const TAIL_COUNT = 30;

const MESSAGE_CAP = 2_200;

const TEXT_CAP = 700;

const TOOL_USE_CAP = 240;

const TOOL_RESULT_CAP = 360;

function configuredInputBudget(): number {
  return DEFAULT_INPUT_BUDGET;
}

/** Format one transcript message while preserving both the beginning and end of long text. */
function formatMessageV3(message: AgentMessage, skipToolResults = false): string {
  const lines: string[] = [`### ${message.role}`];
  let used = lines[0].length;
  const append = (raw: string): void => {
    const remaining = MESSAGE_CAP - used - 1;
    if (remaining <= 0) return;
    const line = clipMiddle(raw, remaining);
    lines.push(line);
    used += line.length + 1;
  };

  for (const block of message.content) {
    if (block.type === 'text') {
      append(clipMiddle(block.text, TEXT_CAP));
    } else if (block.type === 'tool_use') {
      append(`[tool_use ${block.name}] ${clipMiddle(safeJson(block.input), TOOL_USE_CAP)}`);
    } else if (block.type === 'tool_result') {
      if (skipToolResults) continue;
      const content = typeof block.content === 'string' ? block.content : safeJson(block.content);
      if (content.startsWith('[compacted:')) continue;
      append(`[tool_result] ${clipMiddle(content, TOOL_RESULT_CAP)}`);
    }
  }
  return lines.join('\n');
}

function isKeyMiddleMessage(message: AgentMessage): boolean {
  return message.role === 'user' || message.content.some((block) => block.type === 'tool_use');
}

/**
 * Tail-first sampler. Budget is spent on the final messages first, then the
 * start of the interval, then uniformly selected middle events. Assembly is
 * chronological, but a tight budget can only evict older material.
 */
export function formatSpanForPromptV3(
  messages: AgentMessage[],
  budgetChars = configuredInputBudget(),
): string {
  if (messages.length === 0) return '';
  const budget = Math.max(256, Math.floor(budgetChars));
  // Leave room for section markers and separators. This is intentionally
  // proportional so small test/diagnostic budgets still retain useful text.
  let remaining = Math.max(64, budget - Math.min(512, Math.floor(budget * 0.1)));
  const n = messages.length;
  const tailStart = Math.max(0, n - TAIL_COUNT);
  const tailParts: string[] = [];

  // Reserve the tail before considering any older material. Iterate backwards
  // so the final instruction is the last thing that can ever be evicted.
  for (let i = n - 1; i >= tailStart; i--) {
    const formatted = formatMessageV3(messages[i]);
    const needed = formatted.length + 2;
    if (needed <= remaining) {
      tailParts.unshift(formatted);
      remaining -= needed;
      continue;
    }
    if (tailParts.length === 0 && remaining > 24) {
      tailParts.unshift(clipMiddle(formatted, remaining - 2));
      remaining = 0;
    }
    break;
  }

  const headEnd = Math.min(HEAD_COUNT, tailStart);
  const headParts: string[] = [];
  for (let i = 0; i < headEnd; i++) {
    const formatted = formatMessageV3(messages[i]);
    const needed = formatted.length + 2;
    if (needed > remaining) break;
    headParts.push(formatted);
    remaining -= needed;
  }

  const middleParts: string[] = [];
  const middleStart = headEnd;
  const middleEnd = tailStart;
  const keyIndices: number[] = [];
  for (let i = middleStart; i < middleEnd; i++) {
    if (isKeyMiddleMessage(messages[i])) keyIndices.push(i);
  }
  if (remaining > 0 && keyIndices.length > 0) {
    const approximateSlots = Math.max(1, Math.floor(remaining / 320));
    const step = Math.max(1, keyIndices.length / approximateSlots);
    for (let cursor = 0; cursor < keyIndices.length; cursor += step) {
      const index = keyIndices[Math.floor(cursor)];
      const formatted = formatMessageV3(messages[index], true);
      const needed = formatted.length + 2;
      if (needed > remaining) break;
      middleParts.push(formatted);
      remaining -= needed;
    }
  }

  const sections: string[] = [];
  if (headParts.length > 0) {
    sections.push(`--- [start: ${headParts.length} earliest messages in this new span] ---`);
    sections.push(...headParts);
  }
  if (middleEnd > middleStart) {
    sections.push(
      `--- [middle: ${middleEnd - middleStart} messages; ${middleParts.length} key events selected] ---`,
    );
    sections.push(...middleParts);
  }
  sections.push(`--- [tail: ${tailParts.length} most recent messages before cutoff] ---`);
  sections.push(...tailParts);

  const result = sections.join('\n\n');
  // Selection is already tail-first; this final guard keeps the suffix (and
  // therefore the final real instruction) if marker overhead exceeded budget.
  return result.length <= budget ? result : result.slice(-budget);
}
