/**
 * Back-compat shim. The device-bound secret primitive was generalized into
 * `secrets-ipc.ts` (neutral `secrets:*` channels + legacy `ssh:*` aliases), so
 * the SSH client, the database client, and future stores share one home.
 *
 * `mountSshSecretsIpc` is kept as an alias of `mountSecretsIpc` for any caller
 * that still imports it; it registers both channel families exactly once.
 */
export { mountSecretsIpc as mountSshSecretsIpc, mountSecretsIpc } from './secrets-ipc.js';
