/**
 * Task-preflight prompt construction + shared seed/IO types.
 *
 * The analyzer is a cheap one-shot model: user's FIRST prompt + project
 * memory index + tool catalog (native + external MCP) + skill catalog in →
 * strict JSON out. Output parsing lives in `preflight-parse.ts` (kept
 * separate for LOC discipline) and is re-exported here so existing import
 * sites (`./preflight-prompt.js`) are unaffected.
 */
import type { ChatMessage } from '../../quality/llm-chat.js';

/** Seed applied to a fresh coder session (serializable: crosses the worker boundary). */
export interface PreflightSeed {
  profile?: 'bootstrap' | 'navigate' | 'full';
  /** Tool names to pin visible from turn 1 (≤ maxTools, validated against the catalog). */
  pinTools?: string[];
  /** Project memories the agent should READ (titles only, never content). */
  memories?: Array<{ title: string; reason: string }>;
  /** Skills the agent should consider loading before starting (ids, validated). */
  suggestedSkills?: Array<{ id: string; reason: string }>;
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

export interface PreflightSkillMeta {
  id: string;
  description?: string;
  namespace?: string;
}

export interface PreflightPromptInput {
  userMessage: string;
  toolCatalog: readonly PreflightToolMeta[];
  memoryIndex: readonly PreflightMemoryEntry[];
  skillCatalog: readonly PreflightSkillMeta[];
  maxTools: number;
  maxMemories: number;
  maxSkills: number;
}

const MAX_TASK_CHARS = 2000;

export function buildPreflightMessages(input: PreflightPromptInput): ChatMessage[] {
  const system = [
    'You are a task-preflight analyzer for a coding agent. Given the user\'s first request,',
    'the project\'s memory index, the tool catalog and the skill catalog, output ONLY a JSON',
    'object (no prose, no markdown fences) with this exact shape:',
    '{"task_kind":"bugfix|feature|refactor|explore|docs|config|test|other",',
    ' "profile":"bootstrap|navigate|full",',
    ' "tools":[{"name":"<catalog name>","why":"<=10 words"}],',
    ' "skills":[{"id":"<catalog id>","why":"one line"}],',
    ' "memories":[{"title":"<exact title from the index>","why":"one line"}]}',
    `Rules: pick AT MOST ${input.maxTools} tools the agent will most likely need FIRST`,
    '(read-only exploration counts). The catalog includes external integrations whose names',
    'begin with `ext_` (connected MCP servers) — pin one ONLY when the task clearly needs that',
    'integration. Profile is the smallest that covers the task (bootstrap = read/search only;',
    'navigate = also edit files and run commands; full = also git commits and project administration).',
    `A skill is a reusable, task-specific playbook (e.g. building an API client, a QA flow); list`,
    `AT MOST ${input.maxSkills} skills whose id LITERALLY appears in the skill catalog and whose`,
    'description clearly matches this task. List AT MOST',
    `${input.maxMemories} memories and ONLY titles that literally appear in the index. Empty arrays are valid.`,
    'Do not invent tool names, skill ids or memory titles.',
  ].join('\n');

  const task = input.userMessage.length > MAX_TASK_CHARS
    ? `${input.userMessage.slice(0, MAX_TASK_CHARS)}\n...[truncated]`
    : input.userMessage;

  const catalog = input.toolCatalog
    .map((t) => `${t.name} [${t.tier}]${t.description ? ` ${t.description}` : ''}`)
    .join('\n');

  const parts = [`<task>\n${task}\n</task>`, `<tool_catalog>\n${catalog}\n</tool_catalog>`];

  if (input.skillCatalog.length > 0) {
    const skills = input.skillCatalog
      .map((s) => `- ${s.id} [${s.namespace ?? 'skill'}]${s.description ? ` — ${s.description.replace(/\s+/g, ' ').trim()}` : ''}`)
      .join('\n');
    parts.push(`<skill_catalog>\n${skills}\n</skill_catalog>`);
  }

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

// Re-export parsing from the split module so `./preflight-prompt.js` importers
// (pipeline, tests, barrel) keep working without path churn.
export { parsePreflightOutput, type PreflightParseContext } from './preflight-parse.js';
