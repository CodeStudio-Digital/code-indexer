import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listExtensions, phpIniPath, seedManagedIni, setExtension } from '../php-extensions.js';

let dir: string;

function ini(): string {
  return readFileSync(phpIniPath(dir), 'utf8');
}
function activeLines(name: string): number {
  return ini()
    .split(/\r?\n/)
    .filter((l) => new RegExp(`^extension=${name}$`).test(l.trim())).length;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-php-ext-'));
  mkdirSync(join(dir, 'ext'));
  // A few bundled extension DLLs (Windows build naming).
  for (const f of ['php_curl.dll', 'php_mbstring.dll', 'php_pdo_mysql.dll']) {
    writeFileSync(join(dir, 'ext', f), '');
  }
  // A development ini with extension_dir commented (as PHP ships it).
  writeFileSync(join(dir, 'php.ini-development'), ';extension_dir = "ext"\n;extension=curl\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('php-extensions', () => {
  it('seeds php.ini with an absolute extension_dir and enables defaults', () => {
    seedManagedIni(dir, ['curl', 'mbstring']);
    const text = ini();
    expect(text).toMatch(/extension_dir = "/);
    expect(text).toContain(join(dir, 'ext').replace(/\\/g, '\\\\'));
    expect(activeLines('curl')).toBe(1);
    expect(activeLines('mbstring')).toBe(1);
  });

  it('lists bundled extensions with enabled state', () => {
    seedManagedIni(dir, ['curl']);
    const exts = listExtensions(dir);
    const byName = Object.fromEntries(exts.map((e) => [e.name, e]));
    expect(byName.curl).toMatchObject({ builtin: true, enabled: true });
    expect(byName.mbstring).toMatchObject({ builtin: true, enabled: false });
    expect(byName.pdo_mysql).toMatchObject({ builtin: true, enabled: false });
  });

  it('toggles an extension on and off via the ini', () => {
    seedManagedIni(dir, []);
    setExtension(dir, 'mbstring', true);
    expect(activeLines('mbstring')).toBe(1);
    setExtension(dir, 'mbstring', false);
    expect(activeLines('mbstring')).toBe(0);
    expect(ini()).toContain(';extension=mbstring');
  });

  it('is idempotent — repeated enables do not duplicate the line', () => {
    seedManagedIni(dir, []);
    setExtension(dir, 'curl', true);
    setExtension(dir, 'curl', true);
    setExtension(dir, 'curl', true);
    expect(activeLines('curl')).toBe(1);
  });

  it('enables Zend extensions (opcache/xdebug) via zend_extension=, not extension=', () => {
    writeFileSync(join(dir, 'ext', 'php_opcache.dll'), '');
    seedManagedIni(dir, []);

    setExtension(dir, 'opcache', true);
    const text = ini();
    expect(text).toContain('zend_extension=opcache');
    expect(text).not.toContain('\nextension=opcache');
    // listed as enabled (the read side recognises zend_extension=)
    const opcache = listExtensions(dir).find((e) => e.name === 'opcache');
    expect(opcache).toMatchObject({ enabled: true, builtin: true });

    // toggling off comments the zend directive
    setExtension(dir, 'opcache', false);
    expect(ini()).toContain(';zend_extension=opcache');
    expect(listExtensions(dir).find((e) => e.name === 'opcache')?.enabled).toBe(false);

    // xdebug (external) also routes through zend_extension=
    setExtension(dir, 'xdebug', true);
    expect(ini()).toContain('zend_extension=xdebug');
  });
});
