/**
 * API client for /api/docs-agent/suggestions/* — manifest-based doc
 * collection suggestions.
 */

export type SuggestionStatus = 'pending' | 'approved' | 'dismissed' | 'indexed';

export type SuggestionPackageManager =
  | 'npm'
  | 'pypi'
  | 'cargo'
  | 'go'
  | 'composer'
  | 'rubygems';

export interface DocSourceSuggestion {
  id: number;
  project_id: number;
  package_manager: SuggestionPackageManager;
  package_name: string;
  package_version: string | null;
  suggested_url: string;
  suggested_title: string | null;
  confidence: number;
  status: SuggestionStatus;
  discovered_at: string;
  decided_at: string | null;
  indexed_source_id: number | null;
}

export interface ScanResult {
  ok: true;
  manifestsFound: SuggestionPackageManager[];
  packagesDetected: number;
  suggestionsInserted: number;
  suggestionsSkipped: number;
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      /* ignore body parse error */
    }
    throw new Error(detail);
  }
  return (await response.json()) as T;
}

export async function listSuggestions(opts: {
  projectId: number;
  status?: SuggestionStatus;
}): Promise<DocSourceSuggestion[]> {
  const params = new URLSearchParams();
  params.set('project_id', String(opts.projectId));
  if (opts.status) params.set('status', opts.status);
  const response = await fetch(`/api/docs-agent/suggestions?${params.toString()}`);
  const json = await jsonOrThrow<{ suggestions: DocSourceSuggestion[] }>(response);
  return json.suggestions;
}

export async function scanSuggestions(projectId: number, projectRoot?: string): Promise<ScanResult> {
  const response = await fetch('/api/docs-agent/suggestions/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, project_root: projectRoot }),
  });
  return jsonOrThrow<ScanResult>(response);
}

export async function approveSuggestion(
  id: number,
  opts: { collectionId?: number; collectionName?: string },
): Promise<{ ok: true; source: { id: number; collection_id: number } }> {
  const response = await fetch(`/api/docs-agent/suggestions/${id}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collection_id: opts.collectionId,
      collection_name: opts.collectionName,
    }),
  });
  return jsonOrThrow(response);
}

export async function dismissSuggestion(id: number): Promise<void> {
  const response = await fetch(`/api/docs-agent/suggestions/${id}/dismiss`, {
    method: 'POST',
  });
  await jsonOrThrow(response);
}

export async function deleteSuggestion(id: number): Promise<void> {
  const response = await fetch(`/api/docs-agent/suggestions/${id}`, { method: 'DELETE' });
  await jsonOrThrow(response);
}
