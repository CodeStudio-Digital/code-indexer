import type { McpOAuthRegistration } from '../domain/oauth-registration.js';

/**
 * Read-only surface used by the bearer resolver on every tool call.
 * Segregated from the admin interface so hot-path callers cannot
 * accidentally mutate.
 */
export interface McpOAuthRegistrationReaderRepo {
  findByServerId(serverId: string): McpOAuthRegistration | null;
}

export interface McpOAuthRegistrationAdminRepo {
  upsert(registration: McpOAuthRegistration): void;
  delete(serverId: string): void;
  listAll(): McpOAuthRegistration[];
}
