import { describe, expect, it } from 'vitest';
import { newCompanySessionId } from '@mcp/session-storage';
import {
  engineKind,
  pickConnection,
  resolveDbScope,
  sanitizeSlug,
  type ConnLite,
} from '../scope.js';

const COMPANY_SESSION_ID = newCompanySessionId();

const conn = (over: Partial<ConnLite> = {}): ConnLite => ({
  id: 1,
  project_id: 10,
  label: 'main',
  engine: 'postgres',
  is_read_only: 0,
  ...over,
});

describe('resolveDbScope', () => {
  it('single session: names are the bare labels', () => {
    const scope = resolveDbScope({
      projectId: 10,
      connections: [{ conn: conn() }, { conn: conn({ id: 2, label: 'analytics' }) }],
    });
    expect(scope.map((s) => s.name)).toEqual(['main', 'analytics']);
  });

  it('company session: names are <slug>:<label>', () => {
    const scope = resolveDbScope({
      companySessionId: COMPANY_SESSION_ID,
      connections: [
        { conn: conn(), projectSlug: 'api' },
        { conn: conn({ id: 2, project_id: 11 }), projectSlug: 'frontend' },
      ],
    });
    expect(scope.map((s) => s.name)).toEqual(['api:main', 'frontend:main']);
  });

  it('company session: null slug falls back to project-<id>', () => {
    const scope = resolveDbScope({
      companySessionId: COMPANY_SESSION_ID,
      connections: [{ conn: conn({ project_id: 42 }), projectSlug: null }],
    });
    expect(scope[0].name).toBe('project-42:main');
  });

  it('duplicate names get a #<id> suffix so every row stays reachable', () => {
    const scope = resolveDbScope({
      projectId: 10,
      connections: [{ conn: conn({ id: 1 }) }, { conn: conn({ id: 2 }) }],
    });
    expect(scope.map((s) => s.name)).toEqual(['main', 'main#2']);
  });
});

describe('sanitizeSlug', () => {
  it('normalizes separators and strips unsafe chars', () => {
    expect(sanitizeSlug('My App: prod', 5)).toBe('My-App-prod');
    expect(sanitizeSlug('  ', 5)).toBe('project-5');
    expect(sanitizeSlug(undefined, 5)).toBe('project-5');
  });
});

describe('engineKind', () => {
  it('maps engines without connecting', () => {
    expect(engineKind('mongodb')).toBe('document');
    expect(engineKind('redis')).toBe('keyvalue');
    expect(engineKind('postgres')).toBe('relational');
    expect(engineKind('sqlite')).toBe('relational');
  });
});

describe('pickConnection', () => {
  const scope = resolveDbScope({
    companySessionId: COMPANY_SESSION_ID,
    connections: [
      { conn: conn({ id: 1, label: 'main' }), projectSlug: 'api' },
      { conn: conn({ id: 2, label: 'cache', project_id: 11 }), projectSlug: 'frontend' },
    ],
  });

  it('empty scope → didactic Databases-tab error', () => {
    const r = pickConnection([], undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Databases tab');
  });

  it('single connection is the default', () => {
    const r = pickConnection(scope.slice(0, 1), undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe('api:main');
  });

  it('multiple connections without a name → error listing the names', () => {
    const r = pickConnection(scope, '');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('api:main');
      expect(r.error).toContain('frontend:cache');
      expect(r.error).toContain('db_list');
    }
  });

  it('exact name and unambiguous bare label both resolve', () => {
    const exact = pickConnection(scope, 'frontend:cache');
    expect(exact.ok && exact.value.conn.id).toBe(2);
    const bare = pickConnection(scope, 'cache');
    expect(bare.ok && bare.value.conn.id).toBe(2);
  });

  it('unknown name → error with the known names', () => {
    const r = pickConnection(scope, 'nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("No connection named 'nope'");
    if (!r.ok) expect(r.error).toContain('api:main');
  });
});
