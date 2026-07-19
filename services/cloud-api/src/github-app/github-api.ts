import { createGitHubAppJwt } from './crypto.js';
import type { GitHubAppConfig, GitHubInstallation } from './types.js';

const API_VERSION = '2026-03-10';
const USER_AGENT = 'MegaBrainStudio-GitHub-App';

export class GitHubApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

async function githubRequest<T>(config: GitHubAppConfig, path: string, init: RequestInit, bearer: string): Promise<T> {
  const response = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${bearer}`,
      'x-github-api-version': API_VERSION,
      'user-agent': USER_AGENT,
      ...init.headers,
    },
  });
  const text = await response.text();
  let payload: unknown = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* GitHub may return an empty response. */ }
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'message' in payload
      ? String((payload as { message: unknown }).message)
      : `GitHub returned ${response.status}`;
    throw new GitHubApiError(response.status, message);
  }
  return payload as T;
}

export function githubUserAuthorizeUrl(config: GitHubAppConfig, state: string, callbackUrl: string): string {
  const query = new URLSearchParams({ client_id: config.clientId, redirect_uri: callbackUrl, state });
  return `${config.webUrl}/login/oauth/authorize?${query.toString()}`;
}

export async function exchangeGitHubUserCode(config: GitHubAppConfig, code: string, callbackUrl: string): Promise<string> {
  const response = await fetch(`${config.webUrl}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: callbackUrl }),
  });
  const payload = (await response.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!response.ok || !payload.access_token) throw new GitHubApiError(response.status, payload.error_description || 'GitHub authorization failed.');
  return payload.access_token;
}

export async function listUserInstallations(config: GitHubAppConfig, userToken: string): Promise<GitHubInstallation[]> {
  const result = await githubRequest<{ installations?: GitHubInstallation[] }>(
    config,
    '/user/installations?per_page=100',
    { method: 'GET' },
    userToken,
  );
  return Array.isArray(result.installations) ? result.installations : [];
}

export async function repositoryInstallation(config: GitHubAppConfig, owner: string, repo: string): Promise<GitHubInstallation> {
  const jwt = await createGitHubAppJwt(config);
  return githubRequest<GitHubInstallation>(
    config,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
    { method: 'GET' },
    jwt,
  );
}

export async function createInstallationToken(
  config: GitHubAppConfig,
  installationId: number,
  repository: string,
  permissions: Record<string, 'read' | 'write'>,
): Promise<{ token: string; expiresAt: string }> {
  const jwt = await createGitHubAppJwt(config);
  const result = await githubRequest<{ token: string; expires_at: string }>(
    config,
    `/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repositories: [repository], permissions }),
    },
    jwt,
  );
  if (!result.token || !result.expires_at) throw new GitHubApiError(502, 'GitHub returned an invalid installation token.');
  return { token: result.token, expiresAt: result.expires_at };
}

export async function createGitHubPullRequest(
  config: GitHubAppConfig,
  installationId: number,
  input: { owner: string; repo: string; head: string; base: string; title: string; body: string; draft: boolean },
) {
  const auth = await createInstallationToken(config, installationId, input.repo, { contents: 'read', pull_requests: 'write' });
  return githubRequest<{ number: number; html_url: string; title: string; state: string }>(
    config,
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ head: input.head, base: input.base, title: input.title, body: input.body, draft: input.draft }),
    },
    auth.token,
  );
}
