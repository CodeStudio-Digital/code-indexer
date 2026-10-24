import type { CodeIndexDB } from '@mcp/store/db.js';
import type { RepoMapFile } from '@mcp/store/db/agent-repo-map.js';

/** Render an already bounded ranked page. Symbols are previews, not a complete
 * outline; the file/line recovery remains visible even without a token budget. */
export function renderRepoMap(page: { items: RepoMapFile[]; total: number; offset: number; nextOffset?: number }): string {
  if (!page.total) return '(empty project)';
  const lines = [`# Repository Map (${page.total} files; ${page.items.length} shown at offset ${page.offset})`, ''];
  for (const file of page.items) {
    const badges = [...(file.is_entry_point ? ['entry'] : []), ...(file.dependent_count ? [`hub:${file.dependent_count}`] : [])];
    lines.push(file.path + (badges.length ? ` [${badges.join(', ')}]` : ''));
    for (const symbol of file.symbols) lines.push(`  ${symbol.line} ${symbol.kind} ${symbol.name}: ${symbol.signature}${symbol.signature_characters > 80 ? '…' : ''}`);
    if (file.symbol_count > file.symbols.length) lines.push(`  [${file.symbols.length}/${file.symbol_count} supported symbols shown; get_file_skeleton for the outline]`);
  }
  if (page.items.length < page.total) lines.push(`File continuation: get_repo_map(offset=${page.nextOffset ?? 0}). Restart at zero after index changes.`);
  return lines.join('\n');
}

/** Compatibility entry point for callers which request a compact text map. */
export function buildRepoMap(db: CodeIndexDB, projectId: number, maxTokens = 2000): string {
  const text = renderRepoMap(db.listAgentRepoMap(projectId));
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return '';
  const chars = Math.floor(maxTokens * 4);
  if (text.length <= chars) return text;
  let end = chars;
  if (end && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end) + '\n[Map text omitted by budget; use get_repo_map without max_tokens and follow file pages.]';
}
