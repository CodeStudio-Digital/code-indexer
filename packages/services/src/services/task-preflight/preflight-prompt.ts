/**
 * Task-preflight prompt + robust output parsing.
 *
 * The analyzer is a cheap one-shot model: user's FIRST prompt + project
 * memory index (titles/excerpts) + tool catalog in → strict JSON out.
 * Parsing is defensive: every field fails independently, unknown tool
 * names and memory titles are dropped, and an empty validated seed is
 * reported as a parse failure (the session then runs exactly as today).
 */
import type { ChatMessage } from '../../quality/llm-chat.js';

/** Seed applied to a fresh coder session (serializable: crosses the worker boundary). */
export interface PreflightSeed {
  profile?: 'bootstrap' | 'navigate' | 'full';
  /** Tool names to pin visible from turn 1 (≤ maxTools, validated against the catalog). */
  pinTools?: string[];
  /** Project memories the agent should READ (titles only, never content). */
  memories?: Array<{ title: string; reason: string }>;
  taskKind?: string;
}

export interface PreflightToolMeta {
  name: string;
  tier: string;
  description?: string;
}

export interface PreflightMemoryEntry {
  title: string;
  category?: string;
  excerpt?: string;
}

export interface PreflightPromptInput {
  userMessage: string;
  toolCatalog: readonly PreflightToolMeta[];
  memoryIndex: readonly PreflightMemoryEntry[];
  maxTools: number;
  maxMemories: number;
}

const TASK_KINDS = new Set(['bugfix', 'feature', 'refactor', 'explore', 'docs', 'config', 'test', 'other']);
const PROFILES = new Set(['bootstrap', 'navigate', 'full']);
const MAX_TASK_CHARS = 2000;
const MAX_REASON_CHARS = 120;

export function buildPreflightMessages(input: PreflightPromptInput): ChatMessage[] {
  const system = [
    'You are a task-preflight analyzer for a coding agent. Given the user\'s first request,',
    'the project\'s memory index and the tool catalog, output ONLY a JSON object (no prose,',
    'no markdown fences) with this exact shape:',
    '{"task_kind":"bugfix|feature|refactor|explore|docs|config|test|other",',
    ' "profile":"bootstrap|navigate|full",',
    ' "tools":[{"name":"<catalog name>","why":"<=10 words"}],',
    ' "memories":[{"title":"<exact title from the index>","why":"one line"}]}',
    `Rules: pick AT MOST ${input.maxTools} tools the agent will most likely need FIRST`,
    '(read-only exploration counts); profile is the smallest that covers the task',
    '(bootstrap = read/search only; navigate = also edit files and run commands;',
    `full = also git commits and project administration); list AT MOST ${input.maxMemories} memories`,
    'and ONLY titles that literally appear in the index; empty arrays are valid.',
    'Do not invent tool names or memory titles.',
  ].join('\n');

  const task = input.userMessage.length > MAX_TASK_CHARS
    ? `${input.userMessage.slice(0, MAX_TASK_CHARS)}\n...[truncated]`
    : input.userMessage;

  const catalog = input.toolCatalog
    .map((t) => `${t.name} [${t.tier}]${t.description ? ` ${t.description}` : ''}`)
    .join('\n');

  const parts = [`<task>\n${task}\n</task>`, `<tool_catalog>\n${catalog}\n</tool_catalog>`];
  if (input.memoryIndex.length > 0) {
    const memory = input.memoryIndex
      .map((m) => `- [${m.category ?? 'note'}] ${m.title}${m.excerpt ? ` — "${m.excerpt.replace(/\s+/g, ' ').trim()}"` : ''}`)
      .join('\n');
    parts.push(`<memory_index>\n${memory}\n</memory_index>`);
  }

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('empty response');
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(fenced);
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('response was not JSON');
  }
}

export interface PreflightParseContext {
  toolNames: ReadonlySet<string>;
  memoryTitles: readonly string[];
  maxTools: number;
  maxMemories: number;
}

/**
 * Validate + clamp the analyzer output. Returns null when nothing usable
 * survives (caller reports `parse_fail` and the session runs unseeded).
 */
export function parsePreflightOutput(raw: string, ctx: PreflightParseContext): PreflightSeed | null {
  let parsed: Record<string, unknown>;
  try {
    const value = extractJson(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }

  const seed: PreflightSeed = {};

  if (typeof parsed.profile === 'string' && PROFILES.has(parsed.profile)) {
    seed.profile = parsed.profile as PreflightSeed['profile'];
  }
  if (typeof parsed.task_kind === 'string' && TASK_KINDS.has(parsed.task_kind)) {
    seed.taskKind = parsed.task_kind;
  }

  if (Array.isArray(parsed.tools)) {
    const pins: string[] = [];
    for (const item of parsed.tools) {
      const name = typeof item === 'string' ? item : (item as { name?: unknown } | null)?.name;
      if (typeof name !== 'string') continue;
      const trimmed = name.trim();
      if (!ctx.toolNames.has(trimmed) || pins.includes(trimmed)) continue;
      pins.push(trimmed);
      if (pins.length >= ctx.maxTools) break;
    }
    if (pins.length > 0) seed.pinTools = pins;
  }

  if (Array.isArray(parsed.memories)) {
    const byLowerTitle = new Map(ctx.memoryTitles.map((t) => [t.toLowerCase(), t]));
    const memories: Array<{ title: string; reason: string }> = [];
    for (const item of parsed.memories) {
      if (!item || typeof item !== 'object') continue;
      const row = item as { title?: unknown; why?: unknown };
      if (typeof row.title !== 'string') continue;
      const canonical = byLowerTitle.get(row.title.trim().toLowerCase());
      if (!canonical || memories.some((m) => m.title === canonical)) continue;
      const reason = typeof row.why === 'string' ? row.why.trim().slice(0, MAX_REASON_CHARS) : '';
      memories.push({ title: canonical, reason });
      if (memories.length >= ctx.maxMemories) break;
    }
    if (memories.length > 0) seed.memories = memories;
  }

  const usable = seed.profile !== undefined || (seed.pinTools?.length ?? 0) > 0 || (seed.memories?.length ?? 0) > 0;
  return usable ? seed : null;
}
