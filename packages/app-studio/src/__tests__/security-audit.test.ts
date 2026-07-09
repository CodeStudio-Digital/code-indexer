import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSecurityAudit } from '../audit/security.js';
import { makeSpec } from './fixtures.js';

let dir: string | null = null;

function makeWorkspace(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), 'app-audit-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, contents, 'utf8');
  }
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const BASE = {
  '.gitignore': 'node_modules\n.dev.vars\n',
  'wrangler.jsonc': '{ "name": "x", "d1_databases": [{ "binding": "DB" }] }',
};

describe('runSecurityAudit', () => {
  it('is clean on the happy path', () => {
    const ws = makeWorkspace(BASE);
    const result = runSecurityAudit(ws, makeSpec());
    expect(result.errors).toEqual([]);
  });

  it('catches hardcoded secrets and interpolated SQL', () => {
    const ws = makeWorkspace({
      ...BASE,
      'worker/api.ts': [
        "const apiKey = 'sk_live_abcdef123456789';",
        'db.prepare(`SELECT * FROM pedidos WHERE id = ${id}`).all();',
      ].join('\n'),
    });
    const { errors } = runSecurityAudit(ws, makeSpec());
    expect(errors.join('\n')).toContain('hardcoded credential');
    expect(errors.join('\n')).toContain('.bind(');
  });

  it('treats CORS wildcard as error with auth, warning without', () => {
    const files = { ...BASE, 'worker/index.ts': "app.use(cors({ origin: '*' }));" };
    const noAuth = runSecurityAudit(makeWorkspace(files), makeSpec());
    expect(noAuth.errors.join()).not.toContain('cors');
    expect(noAuth.warnings.join()).toContain('cors');
    rmSync(dir!, { recursive: true, force: true });

    const withAuth = runSecurityAudit(
      makeWorkspace(files),
      makeSpec({ auth: { enabled: true, methods: ['password'] } }),
    );
    expect(withAuth.errors.join()).toContain('cors');
  });

  it('requires requireAuth middleware when screens are protected', () => {
    const ws = makeWorkspace({ ...BASE, 'worker/api.ts': 'export const routes = 1;' });
    const spec = makeSpec({ auth: { enabled: true, methods: ['password'], protected_screen_ids: ['painel'] } });
    expect(runSecurityAudit(ws, spec).errors.join('\n')).toContain('requireAuth');
  });

  it('flags a broken or DB-less wrangler.jsonc', () => {
    const broken = runSecurityAudit(makeWorkspace({ ...BASE, 'wrangler.jsonc': '{ nope' }), makeSpec());
    expect(broken.errors.join('\n')).toContain('does not parse');
    rmSync(dir!, { recursive: true, force: true });

    const noDb = runSecurityAudit(makeWorkspace({ ...BASE, 'wrangler.jsonc': '{ "name": "x" }' }), makeSpec());
    expect(noDb.errors.join('\n')).toContain('d1_databases binding "DB"');
  });

  it('warns when the worker reads env vars without .dev.vars', () => {
    const ws = makeWorkspace({ ...BASE, 'worker/api.ts': 'const k = env.MY_SECRET;' });
    expect(runSecurityAudit(ws, makeSpec()).warnings.join('\n')).toContain('.dev.vars is missing');
  });
});
