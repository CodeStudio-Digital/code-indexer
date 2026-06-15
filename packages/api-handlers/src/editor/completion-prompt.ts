/**
 * FIM-via-chat prompt + output post-processing for inline autocomplete.
 *
 * We target plain chat completions (every binding kind speaks it) instead
 * of provider-specific FIM endpoints, so the output needs scrubbing: chat
 * models love fences, echo the prefix, and re-type the code that already
 * sits after the cursor. All trimming here is pure string work — testable
 * without a provider.
 */
import type { ChatMessage } from '@mcp/services/quality/llm-chat.js';

export interface PromptWindows {
  prefix: string;
  suffix: string;
}

/** Clamp prefix/suffix to the configured line windows (server-side cap). */
export function trimWindows(
  prefix: string,
  suffix: string,
  maxPrefixLines: number,
  maxSuffixLines: number,
): PromptWindows {
  const p = prefix.split('\n');
  const s = suffix.split('\n');
  return {
    prefix: p.slice(Math.max(0, p.length - maxPrefixLines)).join('\n'),
    suffix: s.slice(0, maxSuffixLines).join('\n'),
  };
}

const SYSTEM_PROMPT = [
  'You are an inline code completion engine inside an IDE.',
  'Output ONLY the raw code to insert at the <CURSOR> marker — no markdown,',
  'no code fences, no explanations, no surrounding quotes.',
  'Never repeat the code that is already before the cursor.',
  'Match the surrounding indentation and code style exactly.',
  'Keep it short: finish the current statement or small block, then stop.',
].join(' ');

export function buildCompletionMessages(input: {
  language: string;
  file: string;
  windows: PromptWindows;
  context: string;
}): ChatMessage[] {
  const contextBlock = input.context
    ? `Signatures from imported project files (for reference only):\n${input.context}\n\n`
    : '';
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Language: ${input.language}\nFile: ${input.file}\n\n` +
        contextBlock +
        `Complete the code at <CURSOR>:\n\n${input.windows.prefix}<CURSOR>${input.windows.suffix}`,
    },
  ];
}

/** Strip a single wrapping markdown fence, keeping the inner code. */
function stripFences(text: string): string {
  const m = text.match(/^\s*```[\w-]*\r?\n([\s\S]*?)(\r?\n```\s*)?$/);
  return m ? (m[1] ?? '') : text;
}

/**
 * Drop inline reasoning from thinking models (GLM/Qwen emit
 * `<think>…</think>` INSIDE content). An unterminated block means the
 * token budget died mid-reasoning — nothing insertable remains.
 */
function stripThinking(text: string): string {
  const cut = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  return /<think>/i.test(cut) ? '' : cut;
}

/**
 * Scrub the raw model output into insert-ready ghost text.
 *  - fences and stray <CURSOR> markers removed
 *  - prefix echo cut (longest tail-of-prefix that prefixes the output, ≥3)
 *  - suffix overlap cut (model re-typing the code right after the cursor)
 *  - single-line mode keeps only the first line
 * Returns '' when nothing insertable remains.
 */
export function postProcessCompletion(
  raw: string,
  prefix: string,
  suffix: string,
  multiline: boolean,
): string {
  let text = stripFences(stripThinking(raw.replace(/\r\n/g, '\n')));
  // Code followed by a fence + prose ("…\n``` Explanation:") — keep the code.
  const trailingFence = text.indexOf('\n```');
  if (trailingFence >= 0) text = text.slice(0, trailingFence);
  text = text.split('<CURSOR>').join('');

  // Prefix echo: chat models often re-type the current line before adding
  // new code. Cut the longest overlap (min 3 chars to spare legit repeats).
  const tail = prefix.slice(-200);
  for (let len = Math.min(tail.length, text.length); len >= 3; len--) {
    if (text.startsWith(tail.slice(tail.length - len))) {
      text = text.slice(len);
      break;
    }
  }

  if (!multiline) {
    text = text.split('\n')[0] ?? '';
  }

  // Suffix overlap: the buffer already holds `suffix` right after the
  // cursor — if the output ends by re-typing its beginning, drop that part
  // (classic case: closing brackets that already exist).
  const head = suffix.slice(0, 80);
  for (let len = Math.min(head.length, text.length); len >= 2; len--) {
    const candidate = head.slice(0, len);
    if (candidate.trim().length > 0 && text.endsWith(candidate)) {
      text = text.slice(0, text.length - len);
      break;
    }
  }

  // Drop trailing whitespace-only lines (stop sequences leave half-cuts).
  text = text.replace(/[ \t]+$/gm, '').replace(/\n+$/, (m) => (m.length > 1 ? '\n' : ''));
  return text.trim().length === 0 ? '' : text;
}

/**
 * Stop sequences for the chat call. NO fence stop: models that OPEN their
 * answer with ```php get cut at character zero (every response came back
 * empty) — post-processing strips fences instead. Single-line mode stops
 * at the newline (whitespace-only, so the anthropic adapter filters it;
 * postProcess keeps the first line as the belt there).
 */
export function stopSequencesFor(multiline: boolean): string[] {
  return multiline ? [] : ['\n'];
}
