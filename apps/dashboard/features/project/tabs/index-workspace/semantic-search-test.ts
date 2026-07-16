import type {
  ProjectSemanticSearchInput,
  ProjectSemanticSearchResultItem,
  ProjectSemanticSearchTestResult,
} from './project-semantic-api.js';

export type SemanticConsumer = 'pipeline' | 'mcp' | 'agent' | 'monaco' | 'search_everywhere';

export const SEMANTIC_CONSUMER_DEFAULTS: Record<SemanticConsumer, Omit<ProjectSemanticSearchInput, 'query'>> = {
  pipeline: { mode: 'hybrid', type: 'all', limit: 10 },
  mcp: { mode: 'auto', type: 'all', limit: 20 },
  agent: { mode: 'auto', type: 'all', limit: 20 },
  monaco: { mode: 'auto', type: 'all', limit: 20 },
  search_everywhere: { mode: 'auto', type: 'all', limit: 50 },
};

export function semanticResultPath(result: ProjectSemanticSearchResultItem): string {
  return result.type === 'file'
    ? result.data.path ?? ''
    : result.data.file_path ?? '';
}

export function semanticResultLine(result: ProjectSemanticSearchResultItem): number | null {
  return result.type === 'symbol' && typeof result.data.line === 'number'
    ? result.data.line
    : null;
}

export function formatMcpSearchResult(result: ProjectSemanticSearchTestResult): string {
  if (result.results.length === 0) return 'No results found.';
  return result.results.map((row) => {
    const data = row.data;
    if (row.type === 'file') {
      return [
        `## [file] ${data.path ?? ''} (score: ${row.score.toFixed(3)})`,
        `Language: ${data.language ?? '?'} | Lines: ${data.line_count ?? '?'}`,
      ].join('\n');
    }
    return [
      `## [symbol] ${data.name ?? ''} (${data.kind ?? 'symbol'}) — score: ${row.score.toFixed(3)}`,
      `File: ${data.file_path ?? ''}:${data.line ?? '?'}`,
      `Signature: ${data.signature ?? ''}`,
      data.comment ? `Description: ${data.comment}` : '',
      data.parent ? `Parent: ${data.parent}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

export function buildSemanticConsumerPreview(
  consumer: SemanticConsumer,
  projectId: number,
  projectName: string,
  input: ProjectSemanticSearchInput,
  result: ProjectSemanticSearchTestResult,
): string {
  const toolArguments = {
    project_name: projectName,
    query: input.query,
    mode: input.mode,
    type: input.type,
    limit: input.limit,
  };
  if (consumer === 'mcp') return formatMcpSearchResult(result);
  if (consumer === 'agent') {
    return JSON.stringify({
      tool: 'mcp__search',
      arguments: toolArguments,
      content: formatMcpSearchResult(result),
      diagnostics: result.diagnostics,
    }, null, 2);
  }
  if (consumer === 'monaco') {
    return JSON.stringify({
      action: 'semantic_search',
      projectId,
      query: input.query,
      items: result.results.map((row) => ({
        path: semanticResultPath(row),
        line: semanticResultLine(row),
        label: row.type === 'symbol' ? row.data.name : row.data.path,
        kind: row.type === 'symbol' ? row.data.kind : 'file',
        score: row.score,
      })),
    }, null, 2);
  }
  if (consumer === 'search_everywhere') {
    return JSON.stringify({
      call: 'search.project',
      input: {
        projectId,
        query: input.query,
        mode: input.mode,
        type: input.type,
        limit: input.limit,
        supersessionKey: `search-everywhere:p${projectId}`,
      },
      output: result,
    }, null, 2);
  }
  return JSON.stringify({
    request: { projectId, ...input, bypassCache: true },
    response: result,
  }, null, 2);
}
