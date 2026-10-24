import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findDrawioVendorDir } from '../assets/drawio-vendor.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('offline draw.io asset location', () => {
  it('keeps override, packaged resources and source fallback precedence', () => {
    const root = mkdtempSync(join(tmpdir(), 'drawio-location-')); roots.push(root);
    const override = join(root, 'override');
    const packaged = join(root, 'resources/drawio');
    const source = join(root, 'source/apps/http-api/vendor/drawio');
    const options = { overrideDirectory: override, resourcesDirectory: join(root, 'resources'), sourceRoots: [join(root, 'dist'), join(root, 'source')] };
    expect(findDrawioVendorDir(options)).toBeNull();
    for (const candidate of [source, packaged, override]) {
      mkdirSync(candidate, { recursive: true });
      writeFileSync(join(candidate, 'index.html'), '<html></html>');
      expect(findDrawioVendorDir(options)).toBe(candidate);
    }
  });
});
