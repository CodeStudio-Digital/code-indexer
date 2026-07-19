import { spawn } from 'node:child_process';
import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

interface RepositoryTarget {
  owner: string;
  repo: string;
  httpsUrl: string;
}

type BrokerRequest =
  | {
      operation: 'probe';
      target: RepositoryTarget;
    }
  | {
      operation: 'git';
      cwd: string;
      target: RepositoryTarget;
      remoteName: string;
      args: string[];
      timeoutMs: number;
      grant?: string;
    }
  | {
      operation: 'pull_request';
      target: RepositoryTarget;
      head: string;
      base: string;
      title: string;
      body?: string;
      draft?: boolean;
    };

const API_VERSION = '2022-11-28';
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function assertSafeRef(value: string, field: string): void {
  if (!value || value.length > 255 || /[\0-\x20~^:?*[\\]/.test(value) || value.includes('..')) {
    throw new Error(`invalid ${field}`);
  }
}

async function githubRequest<T>(url: string, init: RequestInit, token: string): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'MegaBrainStudio-GitHub-App',
      ...init.headers,
    },
  });
  const text = await response.text();
  let payload: unknown = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'message' in payload
      ? String((payload as { message: unknown }).message)
      : `GitHub API returned ${response.status}`;
    throw new Error(`${message} (${response.status})`);
  }
  return payload as T;
}

async function resolveInstallation(target: RepositoryTarget): Promise<{ id: number; appSlug: string; jwt: string }> {
  const appId = process.env.MEGABRAIN_GITHUB_APP_ID?.trim();
  const keyPath = process.env.MEGABRAIN_GITHUB_APP_PRIVATE_KEY_PATH?.trim();
  const apiUrl = (process.env.MEGABRAIN_GITHUB_APP_API_URL || 'https://api.github.com').replace(/\/$/, '');
  if (!appId || !/^\d+$/.test(appId)) throw new Error('GitHub App ID is not configured');
  if (!keyPath || !path.isAbsolute(keyPath)) throw new Error('GitHub App private-key path is not configured');

  const privateKey = await readFile(keyPath, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encodeJson({ alg: 'RS256', typ: 'JWT' })}.${encodeJson({ iat: now - 60, exp: now + 540, iss: appId })}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const jwt = `${unsigned}.${signer.sign(privateKey).toString('base64url')}`;

  const installation = await githubRequest<{ id: number; app_slug?: string }>(
    `${apiUrl}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/installation`,
    { method: 'GET' },
    jwt,
  );
  return { id: installation.id, appSlug: installation.app_slug || 'megabrainstudio', jwt };
}

async function installationToken(
  target: RepositoryTarget,
  permissions: Record<string, 'read' | 'write'>,
  grant?: string,
): Promise<{ token: string; installationId: number; appSlug: string }> {
  if (process.env.MEGABRAIN_MANAGED_GIT_PROVIDER !== 'local-dev') {
    const brokerUrl = process.env.MEGABRAIN_GITHUB_BROKER_URL?.replace(/\/$/, '');
    if (!brokerUrl || !grant) throw new Error('managed Git cloud grant is missing');
    const response = await fetch(`${brokerUrl}/grants/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'MegaBrainStudio-Git-Broker' },
      body: JSON.stringify({ grant }),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      token?: string;
      repositoryUrl?: string;
      code?: string;
      message?: string;
    };
    if (!response.ok || !payload.token) {
      throw new Error(payload.message || payload.code || `managed Git broker returned ${response.status}`);
    }
    if (payload.repositoryUrl && payload.repositoryUrl.toLowerCase() !== target.httpsUrl.toLowerCase()) {
      throw new Error('managed Git broker repository mismatch');
    }
    return { token: payload.token, installationId: 0, appSlug: 'megabrainstudio' };
  }
  const apiUrl = (process.env.MEGABRAIN_GITHUB_APP_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const installation = await resolveInstallation(target);
  const created = await githubRequest<{ token: string }>(
    `${apiUrl}/app/installations/${installation.id}/access_tokens`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repositories: [target.repo], permissions }),
    },
    installation.jwt,
  );
  return {
    token: created.token,
    installationId: installation.id,
    appSlug: installation.appSlug,
  };
}

async function runGit(request: Extract<BrokerRequest, { operation: 'git' }>) {
  if (!path.isAbsolute(request.cwd)) throw new Error('git cwd must be absolute');
  if (!request.args.length || !['push', 'fetch'].includes(request.args[0] || '')) {
    throw new Error('managed identity only permits git push and fetch');
  }
  if (request.args.some((arg) => typeof arg !== 'string' || /[\0\r\n]/.test(arg))) {
    throw new Error('invalid git argument');
  }
  const remoteIndexes = request.args
    .map((arg, index) => arg === request.remoteName ? index : -1)
    .filter((index) => index >= 0);
  if (remoteIndexes.length !== 1) throw new Error('managed git command must contain the selected remote exactly once');
  const args = [...request.args];
  args[remoteIndexes[0]!] = request.target.httpsUrl;
  // A repository-controlled pre-push hook inherits Git's environment. Do not
  // let it observe the short-lived installation token used by this process.
  if (args[0] === 'push' && !args.includes('--no-verify')) args.splice(1, 0, '--no-verify');

  const auth = await installationToken(request.target, { contents: 'write' }, request.grant);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let truncated = false;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const helper = '!f() { test "$1" = get && printf "%s\\n" "username=x-access-token" "password=$MEGABRAIN_GITHUB_TOKEN"; }; f';
    const child = spawn('git', args, {
      cwd: request.cwd,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
        MEGABRAIN_GITHUB_TOKEN: auth.token,
        GIT_CONFIG_COUNT: '3',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'credential.helper',
        GIT_CONFIG_VALUE_1: helper,
        GIT_CONFIG_KEY_2: 'credential.useHttpPath',
        GIT_CONFIG_VALUE_2: 'true',
      },
    });
    const finish = (value: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const sanitize = (value: string) => value.split(auth.token).join('[REDACTED]');
      const collectedStderr = Buffer.concat(stderr).toString('utf8');
      resolve({
        ...value,
        stdout: sanitize(Buffer.concat(stdout).toString('utf8')),
        stderr: sanitize(collectedStderr || (typeof value.stderr === 'string' ? value.stderr : '')),
        durationMs: Date.now() - startedAt,
        timedOut: timedOut || undefined,
        truncated: truncated || undefined,
      });
    };
    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        truncated = true;
        child.kill('SIGKILL');
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.on('error', (error) => finish({ ok: false, code: -1, errorCode: 'spawn_failed', stderr: error.message }));
    child.on('close', (code) => finish({
      ok: code === 0 && !timedOut && !truncated,
      code: code ?? -1,
      errorCode: timedOut ? 'timeout' : truncated ? 'output_too_large' : code === 0 ? undefined : 'git_failed',
    }));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, Math.max(1_000, Math.min(request.timeoutMs, 5 * 60_000)));
    timer.unref?.();
  });
}

async function createPullRequest(request: Extract<BrokerRequest, { operation: 'pull_request' }>) {
  if (process.env.MEGABRAIN_MANAGED_GIT_PROVIDER !== 'local-dev') {
    throw new Error('cloud pull requests must use the authenticated Worker route');
  }
  assertSafeRef(request.head, 'head branch');
  assertSafeRef(request.base, 'base branch');
  if (!request.title.trim() || request.title.length > 256) throw new Error('invalid pull request title');
  const auth = await installationToken(request.target, { contents: 'write', pull_requests: 'write' });
  const apiUrl = (process.env.MEGABRAIN_GITHUB_APP_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const pull = await githubRequest<{ number: number; html_url: string; title: string; state: string }>(
    `${apiUrl}/repos/${encodeURIComponent(request.target.owner)}/${encodeURIComponent(request.target.repo)}/pulls`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        head: request.head,
        base: request.base,
        title: request.title.trim(),
        body: request.body || '',
        draft: request.draft === true,
      }),
    },
    auth.token,
  );
  return {
    number: pull.number,
    url: pull.html_url,
    title: pull.title,
    state: pull.state,
    appSlug: auth.appSlug,
    installationId: auth.installationId,
  };
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as BrokerRequest;
  const result = request.operation === 'probe'
    ? await resolveInstallation(request.target).then(({ id, appSlug }) => ({ installationId: id, appSlug }))
    : request.operation === 'git'
      ? await runGit(request)
      : await createPullRequest(request);
  process.stdout.write(JSON.stringify({ ok: true, result }));
}

void main().catch((error) => {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
