import type { ContributedLanguageServer } from './types.js';

/** Declare a trusted, host-launched language server contribution. */
export function contributeLanguageServer(
  server: ContributedLanguageServer,
): ContributedLanguageServer {
  return server;
}
