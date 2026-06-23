import { describe, expect, it } from 'vitest';
import {
  packageScope,
  removeNpmrcScopedRegistry,
  upsertNpmrcScopedRegistry,
} from '../npmrc.js';

const URL = 'http://127.0.0.1:4873';

describe('packageScope', () => {
  it('extracts the scope', () => {
    expect(packageScope('@acme/ui')).toBe('@acme');
    expect(packageScope('@a-b.c/x')).toBe('@a-b.c');
  });
  it('returns null for unscoped names', () => {
    expect(packageScope('ui')).toBeNull();
    expect(packageScope('lodash')).toBeNull();
  });
});

describe('upsertNpmrcScopedRegistry', () => {
  it('creates the file content from scratch', () => {
    const r = upsertNpmrcScopedRegistry(null, '@acme/ui', URL);
    expect(r).toEqual({ content: `@acme:registry=${URL}\n`, changed: true, scoped: true });
  });

  it('appends after existing unrelated lines, preserving them', () => {
    const existing = 'fund=false\nlegacy-peer-deps=true\n';
    const r = upsertNpmrcScopedRegistry(existing, '@acme/ui', URL);
    expect(r.changed).toBe(true);
    expect(r.content).toBe(`fund=false\nlegacy-peer-deps=true\n@acme:registry=${URL}\n`);
  });

  it('appends a newline before the line when the file lacks one', () => {
    const r = upsertNpmrcScopedRegistry('fund=false', '@acme/ui', URL);
    expect(r.content).toBe(`fund=false\n@acme:registry=${URL}\n`);
  });

  it('replaces an existing line for the same scope', () => {
    const existing = `fund=false\n@acme:registry=http://old:1\nsave-exact=true\n`;
    const r = upsertNpmrcScopedRegistry(existing, '@acme/ui', URL);
    expect(r.changed).toBe(true);
    expect(r.content).toBe(`fund=false\n@acme:registry=${URL}\nsave-exact=true\n`);
  });

  it('is idempotent when the line is already correct', () => {
    const existing = `@acme:registry=${URL}\n`;
    const r = upsertNpmrcScopedRegistry(existing, '@acme/ui', URL);
    expect(r.changed).toBe(false);
    expect(r.content).toBe(existing);
  });

  it('does not touch other scopes', () => {
    const existing = `@other:registry=http://x:1\n`;
    const r = upsertNpmrcScopedRegistry(existing, '@acme/ui', URL);
    expect(r.content).toBe(`@other:registry=http://x:1\n@acme:registry=${URL}\n`);
  });

  it('preserves CRLF endings', () => {
    const existing = 'fund=false\r\n@acme:registry=http://old:1\r\n';
    const r = upsertNpmrcScopedRegistry(existing, '@acme/ui', URL);
    expect(r.content).toBe(`fund=false\r\n@acme:registry=${URL}\r\n`);
  });

  it('signals unscoped packages without changing content', () => {
    const r = upsertNpmrcScopedRegistry('fund=false\n', 'plainpkg', URL);
    expect(r).toEqual({ content: 'fund=false\n', changed: false, scoped: false });
  });
});

describe('removeNpmrcScopedRegistry', () => {
  it('drops only the matching scope line', () => {
    const existing = `fund=false\n@acme:registry=${URL}\n@other:registry=http://x:1\n`;
    const r = removeNpmrcScopedRegistry(existing, '@acme/ui');
    expect(r.changed).toBe(true);
    expect(r.content).toBe(`fund=false\n@other:registry=http://x:1\n`);
  });

  it('is a no-op when absent, null, or unscoped', () => {
    expect(removeNpmrcScopedRegistry('fund=false\n', '@acme/ui')).toEqual({
      content: 'fund=false\n',
      changed: false,
    });
    expect(removeNpmrcScopedRegistry(null, '@acme/ui')).toEqual({ content: '', changed: false });
    expect(removeNpmrcScopedRegistry('x=1\n', 'plainpkg')).toEqual({ content: 'x=1\n', changed: false });
  });
});
