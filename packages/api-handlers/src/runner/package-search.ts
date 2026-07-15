import { ApiError, type PackageSearchResult } from '@mcp/api-bus';

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new ApiError('upstream', 502, `package registry returned ${response.status}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

function cleanDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 300) : undefined;
}

export async function searchPackages(
  manager: 'maven' | 'gradle' | 'dotnet',
  query: string,
  requestedLimit = 12,
): Promise<PackageSearchResult[]> {
  const q = query.trim();
  if (q.length < 2 || q.length > 120) throw new ApiError('invalid_input', 400, 'package query must be 2-120 characters');
  const numericLimit = Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 12;
  const limit = Math.min(Math.max(numericLimit, 1), 25);
  if (manager === 'dotnet') {
    const data = await fetchJson<{ data?: Array<{ id?: string; version?: string; description?: string }> }>(
      `https://api-v2v3search-0.nuget.org/query?q=${encodeURIComponent(q)}&take=${limit}&prerelease=false`,
    );
    return (data.data ?? []).flatMap((item) => item.id && item.version ? [{
      id: item.id,
      version: item.version,
      description: cleanDescription(item.description),
    }] : []);
  }
  const data = await fetchJson<{ response?: { docs?: Array<{ id?: string; latestVersion?: string }> } }>(
    `https://search.maven.org/solrsearch/select?q=${encodeURIComponent(q)}&rows=${limit}&wt=json`,
  );
  return (data.response?.docs ?? []).flatMap((item) => item.id && item.latestVersion ? [{
    id: item.id,
    version: item.latestVersion,
  }] : []);
}
