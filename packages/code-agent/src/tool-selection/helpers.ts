/**
 * Helpers shared by the pipeline stages.
 */
import type { CoderTool } from '../core/tool.js';
import type { ToolCandidate } from './types.js';
import { NEVER_TRIM } from '../tools/tool-priority.js';

/**
 * Canonical list of tool names that are ALWAYS included in the selection.
 * These are the bare minimum an agent needs to function — pulling them via
 * relevance would risk a model picking poorly and getting stuck.
 *
 * Intentionally short: anything that the agent uses on EVERY task lives here.
 * Specialized tools (e.g. design-system, qa, sandbox) are scored normally.
 */
export const ESSENTIAL_TOOL_NAMES = new Set<string>(NEVER_TRIM);

const CATEGORY_PATTERNS: Array<[RegExp, string]> = [
  [/^(read|write|edit|glob|grep|notebook)/i, 'fs'],
  [/^(bash|powershell|run)/i, 'shell'],
  [/git|github/i, 'git'],
  [/^(qa|test|playwright)/i, 'qa'],
  [/^(mcp_|^mcp\b)/i, 'mcp'],
  [/^(design[_-]?system|component|theme)/i, 'design'],
  [/sandbox|preview|server/i, 'sandbox'],
  [/db|database|sql/i, 'database'],
  [/(todo|task|plan)/i, 'planning'],
  [/(web|fetch|search)/i, 'web'],
];

export function categorizeTool(name: string): string {
  for (const [pattern, label] of CATEGORY_PATTERNS) {
    if (pattern.test(name)) return label;
  }
  return 'other';
}

/**
 * Canonical form of a tool name for policy matching: lowercased with every
 * non-alphanumeric character removed. This lets the Agent Decision Engine's
 * policy names (snake_case, e.g. `web_fetch`) match candidate names regardless
 * of the casing/separator convention actually in use (`WebFetch`, `web_fetch`,
 * `web-fetch` all collapse to `webfetch`).
 *
 * It deliberately does NOT strip the `mcp__` prefix: the engine always emits
 * the full prefixed name (`mcp__search`), and candidates carry the same prefix,
 * so prefix-aware matching is exact while avoiding cross-tool collisions (a bare
 * `search` policy entry must not silently match `mcp__search`).
 */
export function canonicalToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Build a ToolCandidate from a CoderTool. The text concatenation is what
 * gets embedded — name + description + first-line of each parameter to
 * help disambiguate similar tools (e.g. Read vs. ReadFile vs. NotebookRead).
 */
export function toCandidate(tool: CoderTool): ToolCandidate {
  const paramHints = Object.entries(tool.parameters?.properties ?? {})
    .slice(0, 4) // cap to keep embedding-input small
    .map(([key, schema]) => {
      const desc = (schema as { description?: string }).description ?? '';
      return `${key}: ${desc}`;
    })
    .join('; ');
  const descriptionText = `${tool.name}. ${tool.description}. Params: ${paramHints}`.trim();
  return {
    candidateId: tool.name,
    name: tool.name,
    descriptionText,
    tool,
    isEssential: ESSENTIAL_TOOL_NAMES.has(tool.name),
    category: categorizeTool(tool.name),
    score: 0,
    signals: {},
  };
}
