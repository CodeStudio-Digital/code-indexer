/**
 * The MCP server and its inbound auth were removed: an old .env that still
 * sets their keys is ignored and loadConfig keeps working. Only
 * MCP_HTTP_CORS_ORIGINS (CORS of the app's own HTTP API) is still read.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';

const RETIRED = {
  MCP_HTTP_ENABLED: 'true', MCP_HTTP_PATH: '/mcp', MCP_HTTP_STATEFUL: 'true',
  MCP_AUTH_ENABLED: 'true', MCP_AUTH_RATE_LIMIT: '5',
  // Formerly made boot fail without a 32-character MCP_OAUTH_JWT_SECRET.
  MCP_OAUTH_ENABLED: 'true', MCP_OAUTH_ISSUER: 'https://issuer.invalid', MCP_OAUTH_JWT_SECRET: 'short',
  MCP_OAUTH_ACCESS_TTL: '1', MCP_OAUTH_REFRESH_TTL: '1', MCP_OAUTH_ALLOW_DCR: 'false',
};
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('loadConfig with retired MCP server keys', () => {
  it('ignores them and still reads the CORS origins of the app API', () => {
    const root = mkdtempSync(join(tmpdir(), 'retired-mcp-env-')); roots.push(root);
    vi.stubEnv('MCP_INDEX_DB', join(root, 'data', 'index.db'));
    for (const [key, value] of Object.entries(RETIRED)) vi.stubEnv(key, value);
    vi.stubEnv('MCP_HTTP_CORS_ORIGINS', 'http://127.0.0.1:7317, http://localhost:7317');
    const config = loadConfig();
    expect(config.mcp).toEqual({ http: { corsOrigins: ['http://127.0.0.1:7317', 'http://localhost:7317'] } });
  });

  it('leaves the CORS origins empty by default', () => {
    const root = mkdtempSync(join(tmpdir(), 'retired-mcp-env-')); roots.push(root);
    vi.stubEnv('MCP_INDEX_DB', join(root, 'data', 'index.db'));
    vi.stubEnv('MCP_HTTP_CORS_ORIGINS', '');
    expect(loadConfig().mcp).toEqual({ http: { corsOrigins: [] } });
  });
});
