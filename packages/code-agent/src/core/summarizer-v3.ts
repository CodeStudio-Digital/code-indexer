import type { AgentMessage, ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import { loadPrompt } from '@mcp/code-agent/prompts/loader.js';
import { computeCost, lookupStaticPricing } from '@mcp/code-agent/providers/pricing.js';
import type { CompactionSummary, CompactionSummaryV2 } from './summarizer.js';

/**
 * V3 deliberately separates the append-only historical chapter from the
 * small resume snapshot injected back into the model context.
 */
export interface CompactionChapterV3 {
  title: string;
  summary: string;
  user_requests: string[];
  decisions: string[];
  work_completed: string[];
  files: Array<{ path: string; state: string }>;
  open_issues: string[];
  resolved_issues: string[];
}

export interface CompactionResumeV3 {
  objective: string;
  current_focus: string;
  constraints: string[];
  pending_tasks: string[];
  next_step: string;
  /** Ground-truth goal overlay. It is never requested from the model. */
  active_goal?: string;
}

export interface CompactionSummaryMetricsV3 {
  model: string;
  input_chars: number;
  output_chars: number;
  input_messages: number;
  duration_ms: number;
  input_tokens?: number;
  output_tokens?: number;
  compression_ratio: number;
  /** Providers do not expose prices on ChatDelta, so this is null unless a host enriches it. */
  cost_usd?: number | null;
}

export interface CompactionSummaryV3 {
  version: 3;
  chapter: CompactionChapterV3;
  resume: CompactionResumeV3;
  metrics?: CompactionSummaryMetricsV3;
}

export interface CompactionLiveStateV3 {
  goal?: string | { text: string; status?: string } | null;
  activePlan?: string | { text: string; status?: string } | null;
  todos?: Array<{ content: string; activeForm?: string; status: string }>;
  plan?: Array<{ step?: string; content?: string; status: string }>;
}

export interface SummarizeSpanV3Input {
  /** Prior continuation state. It is placed in the system channel, never as a fake user turn. */
  previousResume?: CompactionResumeV3 | string | null;
  /** Only the newly archived conversation interval. */
  messages: AgentMessage[];
  /** Persisted/live state overlaid after the LLM response. */
  liveState?: CompactionLiveStateV3 | null;
}

export interface SummarizeSpanV3Options {
  signal?: AbortSignal;
  /** Hard deadline for the auxiliary call. Defaults to 45 seconds. */
  timeoutMs?: number;
  /** Test/diagnostic override for the prompt sampler budget. */
  budgetChars?: number;
  /** Binding-level deterministic sampling override (clamped by the resolver). */
  temperature?: number;
  /** Binding-level reasoning effort; defaults to minimal. */
  reasoningEffort?: string | null;
  /** Advisory provider output budget mirrored into the strict system prompt. */
  maxOutputTokens?: number;
}

export const COMPACTION_SUMMARY_V3_VERSION = 3 as const;
export const COMPACTION_SUMMARY_TIMEOUT_MS = 45_000;
export const COMPACTION_SUMMARY_MAX_CHARS = 8_000;
export const COMPACTION_SUMMARY_MAX_TOKENS = 1_500;

const SUMMARY_PREFIX_V3 = '[auto-compacted summary of older turns]';
const DEFAULT_INPUT_BUDGET = 120_000;
const HEAD_COUNT = 10;
const TAIL_COUNT = 30;
const MESSAGE_CAP = 2_200;
const TEXT_CAP = 700;
const TOOL_USE_CAP = 240;
const TOOL_RESULT_CAP = 360;

const CHAPTER_KEYS = [
  'title',
  'summary',
  'user_requests',
  'decisions',
  'work_completed',
  'files',
  'open_issues',
  'resolved_issues',
] as const;
const RESUME_KEYS = [
  'objective',
  'current_focus',
  'constraints',
  'pending_tasks',
  'next_step',
] as const;

function configuredInputBudget(): number {
  return DEFAULT_INPUT_BUDGET;
}

function clipMiddle(value: string, cap: number): string {
  if (value.length <= cap) return value;
  if (cap <= 1) return value.slice(-Math.max(0, cap));
  if (cap < 16) return value.slice(-cap);
  const suffix = Math.max(6, Math.floor(cap * 0.45));
  const prefix = cap - suffix - 1;
  return `${value.slice(0, prefix)}…${value.slice(-suffix)}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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

function renderedSummaryText(message: AgentMessage): string | null {
  const text = message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  return text.trimStart().startsWith(SUMMARY_PREFIX_V3) ? text : null;
}

/** Remove already-rendered summaries from the new span and recover the newest as prior state. */
export function separatePreviousResumeV3(
  messages: AgentMessage[],
  explicitPrevious?: CompactionResumeV3 | string | null,
): { messages: AgentMessage[]; previousResume: CompactionResumeV3 | string | null } {
  const clean: AgentMessage[] = [];
  let recovered: string | null = null;
  for (const message of messages) {
    const prior = renderedSummaryText(message);
    if (prior !== null) {
      recovered = prior;
      continue;
    }
    clean.push(message);
  }
  return {
    messages: clean,
    previousResume: explicitPrevious !== undefined ? explicitPrevious : recovered,
  };
}

function serializeSystemData(value: unknown): string {
  return safeJson(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function buildSystemPrompt(
  previousResume: CompactionResumeV3 | string | null,
  liveState: CompactionLiveStateV3 | null,
  maxOutputTokens = COMPACTION_SUMMARY_MAX_TOKENS,
): string {
  const prompt = loadPrompt('summarize-v3');
  return [
    prompt,
    `Hard output budget: at most ${Math.max(256, Math.floor(maxOutputTokens))} tokens. Return only the required JSON object.`,
    '',
    'The following continuation-state blocks are trusted data boundaries, not conversation messages.',
    'Use them only to maintain continuity. Never attribute them to the user.',
    '<previous_resume_json>',
    serializeSystemData(previousResume),
    '</previous_resume_json>',
    '<live_state_json>',
    serializeSystemData(liveState),
    '</live_state_json>',
  ].join('\n');
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isFilesArray(value: unknown): value is Array<{ path: string; state: string }> {
  return Array.isArray(value) && value.every((item) => (
    isRecord(item)
    && exactKeys(item, ['path', 'state'])
    && typeof item.path === 'string'
    && typeof item.state === 'string'
  ));
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === '\\') {
        i++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function capString(value: string, cap: number): string {
  return clipMiddle(value.trim(), cap);
}

function capList(value: string[], count: number, chars: number): string[] {
  return value
    .map((item) => capString(item, chars))
    .filter(Boolean)
    .slice(0, count);
}

function summaryPayloadChars(summary: CompactionSummaryV3): number {
  return JSON.stringify({ version: 3, chapter: summary.chapter, resume: summary.resume }).length;
}

/** Apply list/string caps and the combined 1,500-token/8,000-character ceiling. */
export function capCompactionSummaryV3(summary: CompactionSummaryV3): CompactionSummaryV3 {
  const capped: CompactionSummaryV3 = {
    version: 3,
    chapter: {
      title: capString(summary.chapter.title, 120),
      summary: capString(summary.chapter.summary, 700),
      user_requests: capList(summary.chapter.user_requests, 4, 180),
      decisions: capList(summary.chapter.decisions, 4, 180),
      work_completed: capList(summary.chapter.work_completed, 4, 180),
      files: summary.chapter.files
        .map((file) => ({ path: capString(file.path, 160), state: capString(file.state, 180) }))
        .filter((file) => file.path)
        .slice(0, 6),
      open_issues: capList(summary.chapter.open_issues, 3, 180),
      resolved_issues: capList(summary.chapter.resolved_issues, 3, 180),
    },
    resume: {
      objective: capString(summary.resume.objective, 500),
      current_focus: capString(summary.resume.current_focus, 500),
      constraints: capList(summary.resume.constraints, 4, 180),
      pending_tasks: capList(summary.resume.pending_tasks, 6, 180),
      next_step: capString(summary.resume.next_step, 300),
      ...(summary.resume.active_goal ? { active_goal: capString(summary.resume.active_goal, 300) } : {}),
    },
    ...(summary.metrics ? { metrics: summary.metrics } : {}),
  };

  // A conservative four-chars/token estimate enforces both documented caps.
  const payloadCap = Math.min(
    COMPACTION_SUMMARY_MAX_CHARS,
    COMPACTION_SUMMARY_MAX_TOKENS * 4,
  );
  const removable: Array<unknown[]> = [
    capped.chapter.resolved_issues,
    capped.chapter.files,
    capped.chapter.work_completed,
    capped.chapter.user_requests,
    capped.chapter.decisions,
    capped.chapter.open_issues,
    capped.resume.constraints,
    capped.resume.pending_tasks,
  ];
  while (summaryPayloadChars(capped) > payloadCap) {
    const list = removable.find((candidate) => candidate.length > 1);
    if (list) {
      list.pop();
      continue;
    }
    const scalars: Array<[object, string]> = [
      [capped.chapter, 'summary'],
      [capped.resume, 'current_focus'],
      [capped.resume, 'objective'],
      [capped.resume, 'next_step'],
    ];
    let shrunk = false;
    for (const [owner, key] of scalars) {
      const record = owner as Record<string, unknown>;
      const value = String(record[key] ?? '');
      if (value.length > 80) {
        record[key] = clipMiddle(value, Math.max(80, Math.floor(value.length * 0.8)));
        shrunk = true;
        break;
      }
    }
    if (!shrunk) break;
  }
  return capped;
}

function hasMinimumContent(summary: CompactionSummaryV3): boolean {
  const { chapter, resume } = summary;
  return chapter.summary.length >= 8
    || resume.objective.length >= 8
    || resume.current_focus.length >= 8
    || resume.next_step.length >= 8
    || chapter.user_requests.length > 0
    || chapter.decisions.length > 0
    || chapter.work_completed.length > 0
    || chapter.files.length > 0
    || chapter.open_issues.length > 0
    || chapter.resolved_issues.length > 0
    || resume.constraints.length > 0
    || resume.pending_tasks.length > 0;
}

/** Strict parser: missing, mistyped, or unexpected model fields are rejected. */
export function parseCompactionSummaryV3(text: string): CompactionSummaryV3 | null {
  const json = extractFirstJsonObject(text);
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (!isRecord(value) || !exactKeys(value, ['version', 'chapter', 'resume'])) return null;
    if (value.version !== 3 || !isRecord(value.chapter) || !isRecord(value.resume)) return null;
    if (!exactKeys(value.chapter, CHAPTER_KEYS) || !exactKeys(value.resume, RESUME_KEYS)) return null;
    const chapter = value.chapter;
    const resume = value.resume;
    if (
      typeof chapter.title !== 'string'
      || typeof chapter.summary !== 'string'
      || !isStringArray(chapter.user_requests)
      || !isStringArray(chapter.decisions)
      || !isStringArray(chapter.work_completed)
      || !isFilesArray(chapter.files)
      || !isStringArray(chapter.open_issues)
      || !isStringArray(chapter.resolved_issues)
      || typeof resume.objective !== 'string'
      || typeof resume.current_focus !== 'string'
      || !isStringArray(resume.constraints)
      || !isStringArray(resume.pending_tasks)
      || typeof resume.next_step !== 'string'
    ) return null;

    const parsed = capCompactionSummaryV3({
      version: 3,
      chapter: {
        title: chapter.title,
        summary: chapter.summary,
        user_requests: chapter.user_requests,
        decisions: chapter.decisions,
        work_completed: chapter.work_completed,
        files: chapter.files,
        open_issues: chapter.open_issues,
        resolved_issues: chapter.resolved_issues,
      },
      resume: {
        objective: resume.objective,
        current_focus: resume.current_focus,
        constraints: resume.constraints,
        pending_tasks: resume.pending_tasks,
        next_step: resume.next_step,
      },
    });
    return hasMinimumContent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isCompactionSummaryV3(value: unknown): value is CompactionSummaryV3 {
  if (!isRecord(value) || value.version !== 3 || !isRecord(value.chapter) || !isRecord(value.resume)) {
    return false;
  }
  return typeof value.chapter.title === 'string' && typeof value.resume.objective === 'string';
}

function formatGoal(goal: CompactionLiveStateV3['goal']): string | undefined {
  if (!goal) return undefined;
  if (typeof goal === 'string') return goal;
  return goal.status ? `${goal.text} (status=${goal.status})` : goal.text;
}

/** Persisted tasks are the source of truth; model inference is used only when absent. */
export function overlayLiveStateV3(
  summary: CompactionSummaryV3,
  liveState?: CompactionLiveStateV3 | null,
): CompactionSummaryV3 {
  if (!liveState) return summary;
  let structuredTasks: string[] | undefined;
  if (liveState.todos !== undefined) {
    structuredTasks = liveState.todos
      .filter((todo) => todo.status === 'pending' || todo.status === 'in_progress')
      .map((todo) => `[${todo.status}] ${todo.content}`);
  } else if (liveState.plan !== undefined) {
    structuredTasks = liveState.plan
      .filter((item) => item.status === 'pending' || item.status === 'in_progress')
      .map((item) => `[${item.status}] ${item.step ?? item.content ?? ''}`.trim())
      .filter(Boolean);
  }
  const goal = formatGoal(liveState.goal);
  const activePlan = formatGoal(liveState.activePlan);
  return capCompactionSummaryV3({
    ...summary,
    resume: {
      ...summary.resume,
      ...(structuredTasks !== undefined ? {
        pending_tasks: structuredTasks,
        next_step: structuredTasks.find((task) => task.startsWith('[in_progress]'))
          ?? structuredTasks[0]
          ?? '',
      } : {}),
      ...(goal ? { active_goal: goal } : {}),
      ...(activePlan ? {
        constraints: [
          ...summary.resume.constraints,
          `Persisted active plan: ${activePlan}`,
        ],
      } : {}),
    },
  });
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error('Compaction summarization aborted');
  error.name = 'AbortError';
  return error;
}

function timeoutError(timeoutMs: number): Error {
  const error = new Error(`Compaction summarization timed out after ${timeoutMs}ms`);
  error.name = 'TimeoutError';
  return error;
}

function controlledSignal(external: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(abortError(external?.reason));
  if (external?.aborted) onAbort();
  else external?.addEventListener('abort', onAbort, { once: true });
  const timer = timeoutMs > 0
    ? setTimeout(() => controller.abort(timeoutError(timeoutMs)), timeoutMs)
    : null;
  (timer as { unref?: () => void } | null)?.unref?.();
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

async function collectText(
  provider: ChatProvider,
  request: Parameters<ChatProvider['chat']>[0],
  signal: AbortSignal,
): Promise<{ text: string; usage?: ChatUsage }> {
  if (signal.aborted) throw abortError(signal.reason);
  const iterator = provider.chat(request)[Symbol.asyncIterator]();
  let onAbort: (() => void) | undefined;
  const consume = (async (): Promise<{ text: string; usage?: ChatUsage }> => {
    let text = '';
    let usage: ChatUsage | undefined;
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.type === 'text_delta') text += next.value.text;
      else if (next.value.type === 'usage') usage = next.value.usage;
    }
    return { text, usage };
  })();
  try {
    return await Promise.race([
      consume,
      new Promise<never>((_resolve, reject) => {
        onAbort = (): void => {
          void iterator.return?.();
          reject(abortError(signal.reason));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * One-call V3 summarizer. Previous resume and live state stay in the system
 * channel; only the new archival span is sent as conversation data.
 */
export async function summarizeSpanV3(
  input: SummarizeSpanV3Input,
  provider: ChatProvider,
  options: SummarizeSpanV3Options = {},
): Promise<CompactionSummaryV3 | null> {
  const separated = separatePreviousResumeV3(input.messages, input.previousResume);
  if (separated.messages.length === 0) return null;
  const timeoutMs = options.timeoutMs ?? COMPACTION_SUMMARY_TIMEOUT_MS;
  const control = controlledSignal(options.signal, timeoutMs);
  const startedAt = Date.now();
  try {
    const system = buildSystemPrompt(
      separated.previousResume,
      input.liveState ?? null,
      options.maxOutputTokens,
    );
    const span = formatSpanForPromptV3(separated.messages, options.budgetChars);
    const userContent = `<new_conversation_span>\n${span}\n</new_conversation_span>`;
    const collected = await collectText(provider, {
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: userContent }] }],
      tools: [],
      signal: control.signal,
      thinking: false,
      reasoningEffort: options.reasoningEffort ?? 'minimal',
      inference: { temperature: options.temperature ?? 0 },
    }, control.signal);
    const parsed = parseCompactionSummaryV3(collected.text);
    if (!parsed) return null;
    const withLiveState = overlayLiveStateV3(parsed, input.liveState);
    const durationMs = Math.max(0, Date.now() - startedAt);
    const inputChars = system.length + userContent.length;
    const outputChars = collected.text.length;
    const pricing = lookupStaticPricing(provider.model);
    const estimatedCost = collected.usage && pricing
      ? computeCost(pricing, collected.usage)
      : null;
    const metrics: CompactionSummaryMetricsV3 = {
      model: provider.model,
      input_chars: inputChars,
      output_chars: outputChars,
      input_messages: separated.messages.length,
      duration_ms: durationMs,
      ...(collected.usage ? {
        input_tokens: collected.usage.prompt_tokens_total ?? collected.usage.input_tokens,
        output_tokens: collected.usage.output_tokens,
      } : {}),
      compression_ratio: inputChars > 0 ? Number((outputChars / inputChars).toFixed(4)) : 0,
      cost_usd: estimatedCost,
    };
    const summary: CompactionSummaryV3 = { ...withLiveState, metrics };
    console.log(
      `[coder] summarizer v3 model=${provider.model} input_chars=${inputChars} output_chars=${outputChars} `
      + `input_tokens=${metrics.input_tokens ?? 'n/a'} output_tokens=${metrics.output_tokens ?? 'n/a'} `
      + `duration_ms=${durationMs} ratio=${metrics.compression_ratio} `
      + `cost_usd=${estimatedCost ?? 'n/a'}`,
    );
    return summary;
  } catch (error) {
    if (control.signal.aborted) throw abortError(control.signal.reason);
    console.warn(
      `[coder] summarizer v3 failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  } finally {
    control.cleanup();
  }
}

export function summaryV2ToV3(summary: CompactionSummaryV2): CompactionSummaryV3 {
  return capCompactionSummaryV3({
    version: 3,
    chapter: {
      title: summary.primary_request || 'Conversation progress',
      summary: summary.problem_solving || summary.current_work,
      user_requests: summary.primary_request ? [summary.primary_request] : [],
      decisions: [],
      work_completed: summary.problem_solving ? [summary.problem_solving] : [],
      files: summary.files_and_code,
      open_issues: summary.errors_and_fixes,
      resolved_issues: [],
    },
    resume: {
      objective: summary.primary_request,
      current_focus: summary.current_work,
      constraints: [],
      pending_tasks: summary.pending_tasks,
      next_step: summary.next_step,
      ...(summary.active_goal ? { active_goal: summary.active_goal } : {}),
    },
  });
}

export function summaryV3ToV2(summary: CompactionSummaryV3): CompactionSummaryV2 {
  return {
    primary_request: summary.resume.objective,
    key_concepts: [],
    files_and_code: summary.chapter.files,
    errors_and_fixes: [
      ...summary.chapter.open_issues.map((issue) => `Open: ${issue}`),
      ...summary.chapter.resolved_issues.map((issue) => `Resolved: ${issue}`),
    ],
    problem_solving: summary.chapter.summary || summary.chapter.work_completed.join('; '),
    // V3 intentionally does not duplicate verbatim human messages in summaries.
    all_user_messages: [],
    pending_tasks: summary.resume.pending_tasks,
    current_work: summary.resume.current_focus,
    next_step: summary.resume.next_step,
    ...(summary.resume.active_goal ? { active_goal: summary.resume.active_goal } : {}),
  };
}

export function summaryV3ToLegacy(summary: CompactionSummaryV3): CompactionSummary {
  return {
    what_done: summary.chapter.summary || summary.chapter.work_completed.join('; '),
    current_work: summary.resume.current_focus,
    files_touched: summary.chapter.files.map((file) => file.path),
    decisions: summary.chapter.decisions,
    next_steps: summary.resume.pending_tasks.length > 0
      ? summary.resume.pending_tasks
      : (summary.resume.next_step ? [summary.resume.next_step] : []),
    user_preferences: summary.resume.constraints,
  };
}

/** Compact resume injected into model context; prefix/tags stay V2-compatible. */
export function renderResumeV3(summary: CompactionSummaryV3 | CompactionResumeV3): string {
  const resume = 'resume' in summary ? summary.resume : summary;
  const lines: string[] = [SUMMARY_PREFIX_V3, ''];
  const block = (tag: string, body: string): void => {
    if (!body.trim()) return;
    lines.push(`<${tag}>`, body.trimEnd(), `</${tag}>`, '');
  };
  if (resume.active_goal) block('active_goal', resume.active_goal);
  if (resume.objective) block('primary_request', resume.objective);
  if (resume.current_focus || resume.next_step) {
    block('current_focus', [
      resume.current_focus ? `work: ${resume.current_focus}` : '',
      resume.next_step ? `next: ${resume.next_step}` : '',
    ].filter(Boolean).join('\n'));
  }
  if (resume.constraints.length > 0) {
    block('constraints', resume.constraints.map((item) => `- ${item}`).join('\n'));
  }
  if (resume.pending_tasks.length > 0) {
    block('pending_tasks', resume.pending_tasks.map((item) => `- ${item}`).join('\n'));
  }
  while (lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/** Human-readable chapter text for persistence/search/UI fallbacks. */
export function renderChapterV3(summary: CompactionSummaryV3 | CompactionChapterV3): string {
  const chapter = 'chapter' in summary ? summary.chapter : summary;
  const lines: string[] = [`# ${chapter.title || 'Conversation chapter'}`];
  const section = (title: string, body: string): void => {
    if (!body.trim()) return;
    lines.push('', `## ${title}`, '', body.trimEnd());
  };
  section('Summary', chapter.summary);
  section('User requests', chapter.user_requests.map((item) => `- ${item}`).join('\n'));
  section('Decisions', chapter.decisions.map((item) => `- ${item}`).join('\n'));
  section('Work completed', chapter.work_completed.map((item) => `- ${item}`).join('\n'));
  section('Files', chapter.files.map((file) => `- \`${file.path}\` — ${file.state}`).join('\n'));
  section('Open issues', chapter.open_issues.map((item) => `- ${item}`).join('\n'));
  section('Resolved issues', chapter.resolved_issues.map((item) => `- ${item}`).join('\n'));
  return lines.join('\n');
}

/** Alias used by callers migrating from renderSummaryV2. */
export const renderSummaryV3 = renderResumeV3;
