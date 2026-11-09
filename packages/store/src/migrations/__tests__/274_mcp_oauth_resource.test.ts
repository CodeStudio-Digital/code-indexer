import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { mcpOAuthResource274 } from '../274_mcp_oauth_resource.js';

describe('OAuth resource migration on central and trimmed project databases', () => {
  it('does not recreate global tables in a trimmed project database', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE files (path TEXT); INSERT INTO files VALUES (\'src/keep.ts\')');
      mcpOAuthResource274.up(db);
      expect(db.prepare('SELECT * FROM files').all()).toEqual([{ path: 'src/keep.ts' }]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'mcp_oauth_registrations'").get()).toBeUndefined();
    } finally { db.close(); }
  });
  it('adds columns and preserves existing registration and token data on retries', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE mcp_server_configs (id TEXT, url TEXT);
        CREATE TABLE mcp_oauth_registrations (server_id TEXT, client_secret TEXT);
        CREATE TABLE mcp_oauth_tokens (server_id TEXT, access_token TEXT);
        INSERT INTO mcp_server_configs VALUES ('fixture', 'https://example.test/mcp');
        INSERT INTO mcp_oauth_registrations VALUES ('fixture', 'fixture-secret');
        INSERT INTO mcp_oauth_tokens VALUES ('fixture', 'fixture-token');`);
      mcpOAuthResource274.up(db);
      expect(db.prepare('SELECT resource_url FROM mcp_oauth_registrations').get()).toEqual({ resource_url: 'https://example.test/mcp' });
      db.exec("UPDATE mcp_oauth_registrations SET resource_url = 'https://example.test/canonical', token_endpoint_auth_method = 'client_secret_post'");
      mcpOAuthResource274.up(db);
      expect(db.prepare('SELECT * FROM mcp_oauth_registrations').get()).toEqual({ server_id: 'fixture', client_secret: 'fixture-secret', resource_url: 'https://example.test/canonical', token_endpoint_auth_method: 'client_secret_post' });
      expect(db.prepare('SELECT access_token FROM mcp_oauth_tokens').get()).toEqual({ access_token: 'fixture-token' });
    } finally { db.close(); }
  });
  it('supports a partially upgraded schema without the optional config table', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE mcp_oauth_registrations (server_id TEXT, resource_url TEXT)');
      mcpOAuthResource274.up(db);
      expect(db.prepare('PRAGMA table_info(mcp_oauth_registrations)').all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'token_endpoint_auth_method' })]));
    } finally { db.close(); }
  });
});
