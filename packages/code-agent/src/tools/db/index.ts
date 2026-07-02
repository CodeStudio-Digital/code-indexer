/**
 * The `db_*` agent tool set (v2) — Databases-tab connections, driver-backed.
 * Static array (each tool reads ctx + the module-global bindings), registered
 * once like apiClientTools and gated to the `db` tool tier.
 */
export { dbTools } from './tools.js';
export {
  setDbToolsStores,
  getDbToolsStore,
  getDbToolsSessionProjects,
  setDbSecretDecryptor,
  getDbSecretDecryptor,
  type DbToolsConnectionStore,
  type DbToolsSessionProjects,
  type DbSecretDecryptor,
} from './store-binding.js';
