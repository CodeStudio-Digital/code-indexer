import type { CodeIndexDB } from '@mcp/store/db.js';

export function resolveProject(db: CodeIndexDB, name: string) {
  const project = db.getProjectByName(name);
  if (!project) throw new Error(`Project "${name}" not found. Use list_projects to see available projects.`);
  return project;
}

export function truncateToTokens(text: string, maxTokens?: number): string {
  return truncateToTokensDetailed(text, maxTokens).text;
}

interface TokenTruncationResult {
  text: string;
  truncated: boolean;
  inputChars: number;
  retainedChars: number;
}

/**
 * Apply an explicitly requested approximate token budget while preserving the
 * exact source/retained character counts needed by MCP omission telemetry.
 */
export function truncateToTokensDetailed(text: string, maxTokens?: number): TokenTruncationResult {
  if (!maxTokens || maxTokens <= 0) {
    return { text, truncated: false, inputChars: text.length, retainedChars: text.length };
  }
  const maxChars = Math.max(0, Math.floor(maxTokens * 4));
  if (text.length <= maxChars) {
    return { text, truncated: false, inputChars: text.length, retainedChars: text.length };
  }
  let prefix = text.slice(0, maxChars);
  const tail = prefix.charCodeAt(prefix.length - 1);
  if (tail >= 0xD800 && tail <= 0xDBFF) prefix = prefix.slice(0, -1);
  return {
    text: prefix + `\n\n... [truncated to ~${maxTokens} tokens — rerun without max_tokens or increase it]`,
    truncated: true,
    inputChars: text.length,
    retainedChars: prefix.length,
  };
}

/**
 * Some MCP clients stringify numbers and booleans in tool arguments.
 * Normalize common scalar types so handlers can treat `args.limit` as
 * a number regardless of wire format.
 */
export function coerceArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      if (v === 'true') { out[k] = true; continue; }
      if (v === 'false') { out[k] = false; continue; }
      if (/^-?\d+(\.\d+)?$/.test(v)) { out[k] = Number(v); continue; }
    }
    out[k] = v;
  }
  return out;
}
