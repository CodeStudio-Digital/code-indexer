import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitHubAppManagedGitClient, __testing } from '../client.js';

afterEach(() => vi.unstubAllEnvs());

describe('cloud managed Git client', () => {
  it('accepts github.com remotes without probing a local private key', async () => {
    vi.stubEnv('MEGABRAIN_MANAGED_GIT_PROVIDER', 'cloud');
    vi.stubEnv('MEGABRAIN_GITHUB_BROKER_URL', 'https://cloud.example.test/v1/github');
    const status = await createGitHubAppManagedGitClient().describe('git@github.com:owner/repo.git');
    expect(status).toMatchObject({ available: true, configured: true, host: 'github.com', repository: 'owner/repo' });
  });

  it('never treats an enterprise host as the public GitHub App', async () => {
    vi.stubEnv('MEGABRAIN_MANAGED_GIT_PROVIDER', 'cloud');
    const status = await createGitHubAppManagedGitClient().describe('ssh://git@git.enterprise.test/team/repo.git');
    expect(status).toMatchObject({ available: false, reason: 'unsupported_host', host: 'git.enterprise.test' });
  });

  it('requires a one-use grant before spawning cloud Git', async () => {
    vi.stubEnv('MEGABRAIN_MANAGED_GIT_PROVIDER', 'cloud');
    await expect(createGitHubAppManagedGitClient().runGit({
      cwd: 'D:\\repo',
      remoteUrl: 'https://github.com/owner/repo.git',
      remoteName: 'origin',
      args: ['push', 'origin', 'main'],
    })).rejects.toThrow('managed_identity_grant_required');
  });
});

describe('managed remote parser', () => {
  it('normalizes HTTPS and SCP remotes to the same repository', () => {
    expect(__testing.parseRemote('https://github.com/owner/repo.git', 'github.com')?.repository).toBe('owner/repo');
    expect(__testing.parseRemote('git@github.com:owner/repo.git', 'github.com')?.repository).toBe('owner/repo');
  });
});
