/**
 * Module-level bindings for the `db_*` tools (v2 — Databases tab, migration
 * 174). worker_threads don't share module state, so these are wired in
 * server.ts (main) AND each worker boot (coder/company). Null bindings make
 * the tools return a clear "not wired" message instead of throwing.
 *
 * The connection store is a minimal structural slice of `DbClientStore` —
 * projectId-first so the main process can adapt over `deps.dbClientFor()`
 * (per-project DB split) while workers pass a plain `DbClientStore`.
 */
import type { DbConnection } from '@mcp/store/db-client-store-types.js';

/** What the tools need from DbClientStore (or a per-project adapter over it). */
export interface DbToolsConnectionStore {
  listConnections(projectId: number): DbConnection[];
}

/**
 * Linked projects of a Company session — supplied from the owning filesystem
 * bundle's `session.json`.
 * `label` is the link label (often the service id) used as the connection-name
 * prefix in company scope.
 */
export interface DbToolsSessionProjects {
  listCompanySessionProjects(
    companySessionId: string,
  ): Array<{ project_id: number; label: string | null }>;
}

/**
 * Decrypts a saved `enc:`/`plain:` secret blob to plaintext. Main process
 * injects `getMainSecretDecryptor()`; workers inject an RPC to the
 * `secretsDecrypt` bridge handler (sse/worker-secrets-handlers.ts).
 */
export type DbSecretDecryptor = (blob: string) => Promise<string> | string;

let connStore: DbToolsConnectionStore | null = null;
let sessionProjects: DbToolsSessionProjects | null = null;
let decryptor: DbSecretDecryptor | null = null;

export function setDbToolsStores(
  store: DbToolsConnectionStore | null,
  projects: DbToolsSessionProjects | null,
): void {
  connStore = store;
  sessionProjects = projects;
}

export function getDbToolsStore(): DbToolsConnectionStore | null {
  return connStore;
}

export function getDbToolsSessionProjects(): DbToolsSessionProjects | null {
  return sessionProjects;
}

export function setDbSecretDecryptor(fn: DbSecretDecryptor | null): void {
  decryptor = fn;
}

/**
 * Always returns a callable. The default throws a clear, blob-free error so a
 * connection with an encrypted secret fails loudly in an unwired process
 * instead of silently authenticating with an empty password.
 */
export function getDbSecretDecryptor(): DbSecretDecryptor {
  return (
    decryptor ??
    (() => {
      throw new Error('db secret decryptor not wired in this process');
    })
  );
}
