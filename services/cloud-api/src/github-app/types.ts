export type GitHubRepositorySelection = 'all' | 'selected';
export type GitHubManagedOperation = 'push' | 'fetch';

export interface GitHubAppConfig {
  appId: number;
  slug: string;
  clientId: string;
  clientSecret: string;
  privateKeyJwk: JsonWebKey;
  stateSecret: string;
  host: string;
  webUrl: string;
  apiUrl: string;
}

export interface GitHubInstallation {
  id: number;
  app_id: number;
  app_slug?: string;
  account: { id: number; login: string; type: string };
  repository_selection: GitHubRepositorySelection;
  permissions: Record<string, string>;
  html_url?: string;
  suspended_at?: string | null;
}

export interface LinkedGitHubInstallation {
  installationId: number;
  githubAccountId: number;
  githubAccountLogin: string;
  githubAccountType: string;
  repositorySelection: GitHubRepositorySelection;
  permissions: Record<string, string>;
  appSlug: string;
  manageUrl: string | null;
  suspendedAt: string | null;
  linkedAt: string;
  updatedAt: string;
}

export interface GitHubOperationGrant {
  accountId: string;
  installationId: number;
  repositoryOwner: string;
  repositoryName: string;
  operation: GitHubManagedOperation;
}
