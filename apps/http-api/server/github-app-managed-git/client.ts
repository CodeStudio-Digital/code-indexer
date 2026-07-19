import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  GitIdentityMode,
  ManagedGitClient,
  ManagedGitCommandResult,
  ManagedGitIdentityStatus,
  ManagedPullRequestInput,
  ManagedPullRequestResult,
} from '@mcp/shared/git/managed-git.js';

interface RepositoryTarget {
  host: string;
  owner: string;
  repo: string;
  repository: string;
  httpsUrl: string;
}

interface BrokerEnvelope<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

function parseRemote(remoteUrl: string, supportedHost: string): RepositoryTarget | null {
  const value = remoteUrl.trim();
  let host = '';
  let pathname = '';
  const scp = /^(?:[^@\s]+@)?([^:\s/]+):(.+)$/.exec(value);
  if (scp && !value.includes('://') && !/^[A-Za-z]:[\\/]/.test(value)) {
    host = scp[1] || '';
    pathname = scp[2] || '';
  } else {
    try {
      const parsed = new URL(value);
      if (!['https:', 'ssh:'].includes(parsed.protocol) || parsed.password) return null;
      host = parsed.hostname;
      pathname = parsed.pathname.replace(/^\//, '');
    } catch {
      return null;
    }
  }
  if (host.toLowerCase() !== supportedHost.toLowerCase()) return null;
  const parts = pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) return null;
  const [owner, repo] = parts as [string, string];
  return {
    host,
    owner,
    repo,
    repository: `${owner}/${repo}`,
    httpsUrl: `https://${host}/${owner}/${repo}.git`,
  };
}

function defaultPrivateKeyPath(): string {
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (localAppData) return path.join(localAppData, 'MegaBrain', 'secrets', 'github', 'megabrainstudio.private-key.pem');
  return path.join(os.homedir(), '.megabrain', 'secrets', 'github', 'megabrainstudio.private-key.pem');
}

function childEnvironment(config: {
  providerMode: 'cloud' | 'local-dev';
  brokerUrl: string;
  appId: string;
  privateKeyPath: string;
  apiUrl: string;
}): NodeJS.ProcessEnv {
  const keep = [
    'PATH', 'Path', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
    'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'GIT_SSL_CAINFO',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  env.ELECTRON_RUN_AS_NODE = '1';
  env.MEGABRAIN_MANAGED_GIT_PROVIDER = config.providerMode;
  if (config.providerMode === 'cloud') {
    env.MEGABRAIN_GITHUB_BROKER_URL = config.brokerUrl;
  } else {
    env.MEGABRAIN_GITHUB_APP_ID = config.appId;
    env.MEGABRAIN_GITHUB_APP_PRIVATE_KEY_PATH = config.privateKeyPath;
    env.MEGABRAIN_GITHUB_APP_API_URL = config.apiUrl;
  }
  return env;
}

export function createGitHubAppManagedGitClient(): ManagedGitClient {
  const providerMode = process.env.MEGABRAIN_MANAGED_GIT_PROVIDER === 'local-dev' ? 'local-dev' : 'cloud';
  const cloudBaseUrl = (process.env.CODESTUDIO_CLOUD_URL || 'https://codestudio-cloud-api.maiconspo6792.workers.dev').replace(/\/$/, '');
  const brokerUrl = (process.env.MEGABRAIN_GITHUB_BROKER_URL || `${cloudBaseUrl}/v1/github`).replace(/\/$/, '');
  const appId = (process.env.MEGABRAIN_GITHUB_APP_ID || '4329188').trim();
  const privateKeyPath = (process.env.MEGABRAIN_GITHUB_APP_PRIVATE_KEY_PATH || defaultPrivateKeyPath()).trim();
  const supportedHost = (process.env.MEGABRAIN_GITHUB_APP_HOST || 'github.com').trim().toLowerCase();
  const apiUrl = (process.env.MEGABRAIN_GITHUB_APP_API_URL || 'https://api.github.com').trim();
  const requestedDefault = process.env.MEGABRAIN_GIT_IDENTITY_DEFAULT === 'managed' ? 'managed' : 'project';
  const publicAttribution = process.env.MEGABRAIN_GIT_PUBLIC_ATTRIBUTION !== '0';
  const defaultIdentityMode: GitIdentityMode = requestedDefault === 'managed' && publicAttribution ? 'managed' : 'project';
  const probeCache = new Map<string, { available: boolean; reason?: 'not_installed' | 'authentication_failed'; expiresAt: number }>();

  const runBroker = async <T>(request: object, timeoutMs = 60_000): Promise<T> => {
    const clientFile = fileURLToPath(import.meta.url);
    const extension = path.extname(clientFile);
    const runtime = path.join(path.dirname(clientFile), `runtime${extension}`);
    const args = extension === '.ts' ? ['--import', 'tsx/esm', runtime] : [runtime];
    return new Promise<T>((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        windowsHide: true,
        env: childEnvironment({ providerMode, brokerUrl, appId, privateKeyPath, apiUrl }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
      };
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (error) => finish(error));
      child.on('close', () => {
        if (settled) return;
        const raw = Buffer.concat(stdout).toString('utf8');
        let envelope: BrokerEnvelope<T>;
        try { envelope = JSON.parse(raw) as BrokerEnvelope<T>; } catch {
          finish(new Error(Buffer.concat(stderr).toString('utf8').trim() || 'managed Git broker returned invalid output'));
          return;
        }
        if (!envelope.ok || envelope.result === undefined) {
          finish(new Error(envelope.error || 'managed Git operation failed'));
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(envelope.result);
      });
      child.stdin.end(JSON.stringify(request));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error('managed Git broker timed out'));
      }, timeoutMs + 5_000);
      timer.unref?.();
    });
  };

  const describe = async (remoteUrl: string): Promise<ManagedGitIdentityStatus> => {
    const configured = providerMode === 'cloud'
      ? /^https:\/\//.test(brokerUrl)
      : /^\d+$/.test(appId) && Boolean(privateKeyPath) && Boolean(apiUrl);
    const parsed = parseRemote(remoteUrl, supportedHost);
    if (!parsed) {
      let host: string | null = null;
      try { host = new URL(remoteUrl).hostname || null; } catch { /* SCP or invalid remote */ }
      return {
        available: false,
        configured,
        label: 'MegaBrainStudio',
        host,
        repository: null,
        reason: host && host.toLowerCase() !== supportedHost ? 'unsupported_host' : 'invalid_remote',
      };
    }
    if (!configured) return { available: false, configured: false, label: 'MegaBrainStudio', host: parsed.host, repository: parsed.repository, reason: 'not_configured' };
    // The authenticated cloud route resolves installation ownership. Locally we
    // only validate the remote shape; the Worker validates the one-use grant
    // again immediately before minting an installation token.
    if (providerMode === 'cloud') {
      return { available: true, configured: true, label: 'MegaBrainStudio', host: parsed.host, repository: parsed.repository };
    }
    try {
      await access(privateKeyPath, constants.R_OK);
    } catch {
      return { available: false, configured: true, label: 'MegaBrainStudio', host: parsed.host, repository: parsed.repository, reason: 'private_key_unavailable' };
    }
    const cached = probeCache.get(parsed.repository.toLowerCase());
    if (cached && cached.expiresAt > Date.now()) {
      return {
        available: cached.available,
        configured: true,
        label: 'MegaBrainStudio',
        host: parsed.host,
        repository: parsed.repository,
        reason: cached.reason,
      };
    }
    try {
      await runBroker<{ installationId: number; appSlug: string }>({ operation: 'probe', target: parsed }, 20_000);
      probeCache.set(parsed.repository.toLowerCase(), { available: true, expiresAt: Date.now() + 5 * 60_000 });
    } catch (error) {
      const reason = error instanceof Error && /\(404\)/.test(error.message) ? 'not_installed' : 'authentication_failed';
      probeCache.set(parsed.repository.toLowerCase(), { available: false, reason, expiresAt: Date.now() + 60_000 });
      return { available: false, configured: true, label: 'MegaBrainStudio', host: parsed.host, repository: parsed.repository, reason };
    }
    return { available: true, configured: true, label: 'MegaBrainStudio', host: parsed.host, repository: parsed.repository };
  };

  const requireTarget = async (remoteUrl: string): Promise<RepositoryTarget> => {
    const status = await describe(remoteUrl);
    if (!status.available) throw new Error(`managed_identity_${status.reason || 'unavailable'}`);
    return parseRemote(remoteUrl, supportedHost)!;
  };

  return {
    defaultIdentityMode,
    describe,
    async runGit(input): Promise<ManagedGitCommandResult> {
      const target = await requireTarget(input.remoteUrl);
      if (providerMode === 'cloud' && !input.authorizationGrant) throw new Error('managed_identity_grant_required');
      return runBroker<ManagedGitCommandResult>({
        operation: 'git',
        cwd: input.cwd,
        target,
        remoteName: input.remoteName,
        args: input.args,
        timeoutMs: input.timeoutMs ?? 30_000,
        grant: input.authorizationGrant,
      }, input.timeoutMs ?? 30_000);
    },
    async createPullRequest(input: ManagedPullRequestInput): Promise<ManagedPullRequestResult> {
      if (providerMode === 'cloud') throw new Error('managed_pull_request_requires_cloud_account_route');
      const target = await requireTarget(input.remoteUrl);
      return runBroker<ManagedPullRequestResult>({ operation: 'pull_request', target, ...input }, 60_000);
    },
  };
}

export const __testing = { parseRemote };
