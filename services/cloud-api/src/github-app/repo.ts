import type { GitHubInstallation, GitHubManagedOperation, GitHubOperationGrant, LinkedGitHubInstallation } from './types.js';

interface InstallationRow {
  installation_id: number;
  github_account_id: number;
  github_account_login: string;
  github_account_type: string;
  repository_selection: 'all' | 'selected';
  permissions_json: string;
  app_slug: string;
  manage_url: string | null;
  suspended_at: string | null;
  linked_at: string;
  updated_at: string;
}

function toLinked(row: InstallationRow): LinkedGitHubInstallation {
  let permissions: Record<string, string> = {};
  try { permissions = JSON.parse(row.permissions_json) as Record<string, string>; } catch { /* corrupted metadata fails closed elsewhere */ }
  return {
    installationId: row.installation_id,
    githubAccountId: row.github_account_id,
    githubAccountLogin: row.github_account_login,
    githubAccountType: row.github_account_type,
    repositorySelection: row.repository_selection,
    permissions,
    appSlug: row.app_slug,
    manageUrl: row.manage_url,
    suspendedAt: row.suspended_at,
    linkedAt: row.linked_at,
    updatedAt: row.updated_at,
  };
}

export function createGitHubAppRepo(db: D1Database) {
  return {
    async linkInstallations(accountId: string, installations: GitHubInstallation[]): Promise<void> {
      if (installations.length === 0) return;
      await db.batch(installations.map((installation) => db.prepare(
        `INSERT INTO github_app_installations
          (account_id, installation_id, github_account_id, github_account_login, github_account_type,
           repository_selection, permissions_json, app_slug, manage_url, suspended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, installation_id) DO UPDATE SET
           github_account_id = excluded.github_account_id,
           github_account_login = excluded.github_account_login,
           github_account_type = excluded.github_account_type,
           repository_selection = excluded.repository_selection,
           permissions_json = excluded.permissions_json,
           app_slug = excluded.app_slug,
           manage_url = excluded.manage_url,
           suspended_at = excluded.suspended_at,
           updated_at = datetime('now')`,
      ).bind(
        accountId,
        installation.id,
        installation.account.id,
        installation.account.login,
        installation.account.type,
        installation.repository_selection,
        JSON.stringify(installation.permissions ?? {}),
        installation.app_slug ?? 'megabrainstudio',
        installation.html_url ?? null,
        installation.suspended_at ?? null,
      )));
    },

    async list(accountId: string): Promise<LinkedGitHubInstallation[]> {
      const result = await db.prepare(
        `SELECT installation_id, github_account_id, github_account_login, github_account_type,
                repository_selection, permissions_json, app_slug, manage_url, suspended_at, linked_at, updated_at
           FROM github_app_installations
          WHERE account_id = ?
          ORDER BY github_account_login COLLATE NOCASE`,
      ).bind(accountId).all<InstallationRow>();
      return (result.results ?? []).map(toLinked);
    },

    async find(accountId: string, installationId: number): Promise<LinkedGitHubInstallation | null> {
      const row = await db.prepare(
        `SELECT installation_id, github_account_id, github_account_login, github_account_type,
                repository_selection, permissions_json, app_slug, manage_url, suspended_at, linked_at, updated_at
           FROM github_app_installations WHERE account_id = ? AND installation_id = ?`,
      ).bind(accountId, installationId).first<InstallationRow>();
      return row ? toLinked(row) : null;
    },

    async unlink(accountId: string, installationId: number): Promise<boolean> {
      const result = await db.prepare(
        'DELETE FROM github_app_installations WHERE account_id = ? AND installation_id = ?',
      ).bind(accountId, installationId).run();
      return (result.meta.changes ?? 0) > 0;
    },

    async createGrant(input: GitHubOperationGrant & { tokenHash: string; expiresAt: number }): Promise<void> {
      await db.prepare(
        `INSERT INTO github_app_operation_grants
          (grant_hash, account_id, installation_id, repository_owner, repository_name, operation, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        input.tokenHash,
        input.accountId,
        input.installationId,
        input.repositoryOwner,
        input.repositoryName,
        input.operation,
        input.expiresAt,
      ).run();
    },

    async claimGrant(tokenHash: string, consumedAt: string): Promise<GitHubOperationGrant | null> {
      const row = await db.prepare(
        `UPDATE github_app_operation_grants
            SET consumed_at = ?
          WHERE grant_hash = ? AND consumed_at IS NULL AND expires_at > (unixepoch('now') * 1000)
          RETURNING account_id, installation_id, repository_owner, repository_name, operation`,
      ).bind(consumedAt, tokenHash).first<{
        account_id: string;
        installation_id: number;
        repository_owner: string;
        repository_name: string;
        operation: GitHubManagedOperation;
      }>();
      return row ? {
        accountId: row.account_id,
        installationId: row.installation_id,
        repositoryOwner: row.repository_owner,
        repositoryName: row.repository_name,
        operation: row.operation,
      } : null;
    },

    async recordUsage(input: { id: string; accountId: string | null; installationId: number | null; operation: string; outcome: string }): Promise<void> {
      await db.prepare(
        'INSERT INTO github_app_usage_events (id, account_id, installation_id, operation, outcome) VALUES (?, ?, ?, ?, ?)',
      ).bind(input.id, input.accountId, input.installationId, input.operation, input.outcome).run();
    },
  };
}
