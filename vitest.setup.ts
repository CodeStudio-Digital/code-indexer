/**
 * Global test setup.
 *
 * The repo `.env` may enable the tiered-hybrid per-project DB split
 * (MCP_PROJECT_DB / MCP_PROJECT_DB_ROUTE) for the running app. Tests must NOT
 * inherit that — routing changes which DB rows land in, and the bulk of the
 * suite is written against the single central DB. We therefore trigger dotenv
 * ONCE (so `.env` is applied to the module-cached config), then strip the
 * split flags so every test starts route-OFF and deterministic. Tests that
 * specifically exercise routing (project-db-integration.test.ts) opt back in by
 * setting the env vars in their own bodies.
 */
import '@mcp/shared/utils/config.js'; // side-effect: dotenv/config runs here, once

for (const key of Object.keys(process.env)) {
  if (key.startsWith('MCP_PROJECT_DB') || key.startsWith('MCP_DB_SPLIT')) {
    delete process.env[key];
  }
}
