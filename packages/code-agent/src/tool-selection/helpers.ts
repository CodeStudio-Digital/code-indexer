/**
 * Helpers shared by the pipeline stages.
 */
import type { CoderTool } from '../core/tool.js';
import type { ToolCandidate } from './types.js';

/**
 * Canonical list of tool names that are ALWAYS included in the selection.
 * These are the bare minimum an agent needs to function — pulling them via
 * relevance would risk a model picking poorly and getting stuck.
 *
 * Intentionally short: anything that the agent uses on EVERY task lives here.
 * Specialized tools (e.g. design-system, qa, sandbox) are scored normally.
 */
export const ESSENTIAL_TOOL_NAMES = new Set<string>([
  'Read',
  'Write',
  'Edit',
  'TodoWrite',
  'Bash',
  'Glob',
  'Grep',
  'PowerShell',
]);

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
