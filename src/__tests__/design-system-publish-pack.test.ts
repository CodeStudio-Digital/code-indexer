import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverArtifacts,
  extractPackedTarballName,
  hashTarball,
  shortenError,
} from '@mcp/company/tools/design-system/ds-publish-version.js';

describe('extractPackedTarballName', () => {
  it('reads the filename from npm pack --silent output (single line)', () => {
    expect(extractPackedTarballName('acme-ui-1.0.0.tgz\n')).toBe('acme-ui-1.0.0.tgz');
  });

  it('reads the filename from npm pack non-silent output (multi-line notice + filename last)', () => {
    const stdout = `npm notice
npm notice 📦  @acme/ui@1.0.0
npm notice === Tarball Contents ===
npm notice 1.2kB src/index.ts
npm notice === Tarball Details ===
npm notice name:          @acme/ui
npm notice version:       1.0.0
npm notice filename:      acme-ui-1.0.0.tgz
npm notice
acme-ui-1.0.0.tgz
`;
    expect(extractPackedTarballName(stdout)).toBe('acme-ui-1.0.0.tgz');
  });

  it('handles scoped package names', () => {
    expect(extractPackedTarballName('acme-ui-1.0.0.tgz\n')).toBe('acme-ui-1.0.0.tgz');
    // Scoped package: npm pack actually emits filename without the leading `@`/`/`,
    // but with a hyphen substitution: `@acme/ui-1.0.0` → `acme-ui-1.0.0.tgz`.
    expect(extractPackedTarballName('acme-ui-2.5.7.tgz\r\n')).toBe('acme-ui-2.5.7.tgz');
  });

  it('returns null when no .tgz line is present', () => {
    expect(extractPackedTarballName('')).toBeNull();
    expect(extractPackedTarballName('npm notice some text\n')).toBeNull();
    expect(extractPackedTarballName('error happened\n')).toBeNull();
  });

  it('picks the last .tgz line (in case stdout has multiple notices)', () => {
    const stdout = 'old-1.0.0.tgz (from a previous failed run, not the produced one)\nnew-2.0.0.tgz\n';
    expect(extractPackedTarballName(stdout)).toBe('new-2.0.0.tgz');
  });

  it('trims whitespace defensively', () => {
    expect(extractPackedTarballName('   acme-ui-1.0.0.tgz   \n')).toBe('acme-ui-1.0.0.tgz');
  });
});

describe('shortenError', () => {
  it('returns the input unchanged when shorter than max', () => {
    expect(shortenError('boom', 1200)).toBe('boom');
  });

  it('preserves the TAIL where npm error codes live (regression session 73)', () => {
    // Real-world npm publish stderr shape: a long block of `npm notice`
    // header lines, then the actual error code at the bottom. Prior
    // version of shortenError truncated from the start, hiding the
    // `npm error code ENEEDAUTH` line that explained the failure.
    // Force max=400 so we DEFINITELY truncate; assert ENEEDAUTH stays.
    const head = 'npm notice 5.2kB README.md\n'.repeat(80); // ~2.2kB filler
    const tail = 'npm error code ENEEDAUTH\nnpm error need auth: This command requires you to be logged in to http://127.0.0.1:4873/';
    const full = head + tail;
    const out = shortenError(full, 400);
    expect(out.length).toBeLessThan(full.length);
    expect(out).toContain('ENEEDAUTH');
    expect(out).toContain('need auth');
    expect(out).toContain('truncated');
  });

  it('keeps a small head sample for context', () => {
    const head = 'COMMAND: npm publish ...\n';
    const middle = 'x'.repeat(5000);
    const tail = 'ERROR: it broke';
    const out = shortenError(head + middle + tail, 600);
    // Head context survives so the reader knows what was being run.
    expect(out).toContain('COMMAND: npm publish');
    expect(out).toContain('ERROR: it broke');
  });
});

describe('discoverArtifacts', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mcp-ds-discover-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns all-null when pkg dir is empty', async () => {
    const r = await discoverArtifacts(dir, '/cwd');
    expect(r).toEqual({
      docs_md: null,
      storybook_path: null,
      manifest_json: null,
      mcp_manifest_json: null,
    });
  });

  it('reads docs.md when present', async () => {
    writeFileSync(join(dir, 'docs.md'), '# Hello\n');
    const r = await discoverArtifacts(dir, '/cwd');
    expect(r.docs_md).toBe('# Hello\n');
  });

  it('registers storybook-static directory only when index.html exists', async () => {
    mkdirSync(join(dir, 'storybook-static'), { recursive: true });
    // Without index.html: still null (avoids registering an empty SB build).
    let r = await discoverArtifacts(dir, '/cwd');
    expect(r.storybook_path).toBeNull();
    // With index.html: returns absolute path of the directory.
    writeFileSync(join(dir, 'storybook-static', 'index.html'), '<html/>');
    r = await discoverArtifacts(dir, '/cwd');
    expect(r.storybook_path).toBe(join(dir, 'storybook-static'));
  });

  it('reads manifest.json and validates JSON', async () => {
    writeFileSync(join(dir, 'manifest.json'), '{"components":[]}');
    const r = await discoverArtifacts(dir, '/cwd');
    expect(r.manifest_json).toBe('{"components":[]}');
  });

  it('rejects malformed manifest.json (returns null instead of poisoning the row)', async () => {
    writeFileSync(join(dir, 'manifest.json'), 'this is not json');
    const r = await discoverArtifacts(dir, '/cwd');
    expect(r.manifest_json).toBeNull();
  });

  it('reads mcp/manifest.json when present', async () => {
    mkdirSync(join(dir, 'mcp'), { recursive: true });
    writeFileSync(join(dir, 'mcp', 'manifest.json'), '{"tools":[]}');
    const r = await discoverArtifacts(dir, '/cwd');
    expect(r.mcp_manifest_json).toBe('{"tools":[]}');
  });
});

describe('hashTarball', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mcp-ds-tarhash-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('produces a stable hex SHA-256 of the file bytes', async () => {
    const p = join(dir, 'sample.tgz');
    writeFileSync(p, Buffer.from('hello world'));
    const h = await hashTarball(p);
    // sha256('hello world') is well-known.
    expect(h).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('two byte-identical files hash to the same value', async () => {
    const a = join(dir, 'a.tgz');
    const b = join(dir, 'b.tgz');
    writeFileSync(a, Buffer.from('payload-bytes-x'));
    writeFileSync(b, Buffer.from('payload-bytes-x'));
    expect(await hashTarball(a)).toBe(await hashTarball(b));
  });

  it('one-byte difference produces a different hash (regression: session 73 v1.2.2)', async () => {
    // The whole point of switching from computeSourceHash → hashTarball
    // is detecting build-output changes that the old hash missed
    // because `dist/` and `storybook-static/` were excluded. Lock that
    // hashing the tarball really does respond to any byte change.
    const a = join(dir, 'a.tgz');
    const b = join(dir, 'b.tgz');
    writeFileSync(a, Buffer.from('hello world'));
    writeFileSync(b, Buffer.from('hello worle')); // last char flipped
    expect(await hashTarball(a)).not.toBe(await hashTarball(b));
  });
});
