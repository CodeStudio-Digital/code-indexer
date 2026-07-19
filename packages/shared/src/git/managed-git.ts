export type GitIdentityMode = 'project' | 'managed';

export interface ManagedGitIdentityStatus {
  available: boolean;
  configured: boolean;
  label: string;
  host: string | null;
  repository: string | null;
  reason?:
    | 'not_configured'
    | 'unsupported_host'
    | 'invalid_remote'
    | 'private_key_unavailable'
    | 'not_installed'
    | 'not_connected'
    | 'suspended'
    | 'authentication_failed';
}

export interface ManagedGitCommandResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  durationMs?: number;
  timedOut?: boolean;
  truncated?: boolean;
  errorCode?: 'spawn_failed' | 'timeout' | 'output_too_large' | 'git_failed';
}

export interface ManagedPullRequestInput {
  remoteUrl: string;
  head: string;
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
}

export interface ManagedPullRequestResult {
  number: number;
  url: string;
  title: string;
  state: string;
  appSlug: string;
  installationId: number;
}

/**
 * Narrow server-side port for the optional GitHub App identity. Implementations
 * must not return installation tokens or private-key contents to callers.
 */
export interface ManagedGitClient {
  readonly defaultIdentityMode: GitIdentityMode;
  describe(remoteUrl: string): Promise<ManagedGitIdentityStatus>;
  runGit(input: {
    cwd: string;
    remoteUrl: string;
    remoteName: string;
    args: string[];
    timeoutMs?: number;
    /** Opaque, repository-scoped, one-use broker capability. It is never a
     *  GitHub installation token. Required by the cloud provider only. */
    authorizationGrant?: string;
  }): Promise<ManagedGitCommandResult>;
  createPullRequest(input: ManagedPullRequestInput): Promise<ManagedPullRequestResult>;
}
