/**
 * binary-installer against a LOCAL http fixture server (no real network):
 * a tiny .gz "binary" generated in the test, served from 127.0.0.1, with
 * sha256 verification exercised in both the happy and mismatch paths.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installBinaryServer } from '../binary-installer.js';
import type { LspInstallProgress } from '../server-installer.js';
import type { LspServerDef, LspTargetKey } from '../server-registry.js';

const PAYLOAD = Buffer.from('#!/bin/sh\necho fake-lsp-server\n');
const GZ = gzipSync(PAYLOAD);
const GZ_SHA256 = createHash('sha256').update(GZ).digest('hex');

const ALL_TARGETS: LspTargetKey[] = [
  'win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64',
];

let server: Server;
let baseUrl = '';
const tmpDirs: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/ok.gz') {
      res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': String(GZ.length) });
      res.end(GZ);
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lsp-bin-test-'));
  tmpDirs.push(dir);
  return dir;
}

/** Same asset on every target so the test is host-platform independent. */
function defFor(url: string, sha256?: string, assets?: LspServerDef['install']): LspServerDef {
  return {
    id: 'fake-bin',
    label: 'Fake (binary)',
    languages: ['rust'],
    install: assets ?? {
      kind: 'binary',
      version: '1.0.0',
      binRelPath: 'fake-bin',
      assets: Object.fromEntries(ALL_TARGETS.map((t) => [t, { url, sha256, archive: 'gz' as const }])),
    },
    args: [],
    sizeLabel: '~1 KB',
  };
}

async function collect(gen: AsyncGenerator<LspInstallProgress>): Promise<LspInstallProgress[]> {
  const frames: LspInstallProgress[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

describe('installBinaryServer', () => {
  it('installs a gz single-file binary (no sha256 in the def → no verify)', async () => {
    const dir = freshDir();
    const frames = await collect(installBinaryServer(defFor(`${baseUrl}/ok.gz`), dir));
    expect(frames.at(-1)).toEqual({ phase: 'done', installDir: dir });
    expect(readFileSync(join(dir, 'fake-bin'))).toEqual(PAYLOAD);
    expect(frames.some((f) => f.phase === 'log' && /sha256 verified/.test(f.line))).toBe(false);
    // temp archive is cleaned up
    expect(readdirSync(dir).filter((n) => n.startsWith('_download'))).toEqual([]);
  });

  it('verifies a correct sha256', async () => {
    const dir = freshDir();
    const frames = await collect(installBinaryServer(defFor(`${baseUrl}/ok.gz`, GZ_SHA256), dir));
    expect(frames.at(-1)).toEqual({ phase: 'done', installDir: dir });
    expect(frames.some((f) => f.phase === 'log' && /sha256 verified/.test(f.line))).toBe(true);
  });

  it('fails cleanly on sha256 mismatch — no binary, temp removed', async () => {
    const dir = freshDir();
    const frames = await collect(installBinaryServer(defFor(`${baseUrl}/ok.gz`, 'a'.repeat(64)), dir));
    const last = frames.at(-1)!;
    expect(last.phase).toBe('error');
    expect((last as { message: string }).message).toMatch(/sha256 mismatch/);
    expect(existsSync(join(dir, 'fake-bin'))).toBe(false);
    expect(readdirSync(dir).filter((n) => n.startsWith('_download'))).toEqual([]);
  });

  it('fails cleanly on an http error', async () => {
    const dir = freshDir();
    const frames = await collect(installBinaryServer(defFor(`${baseUrl}/missing.gz`), dir));
    const last = frames.at(-1)!;
    expect(last.phase).toBe('error');
    expect((last as { message: string }).message).toMatch(/download failed \(404\)/);
    expect(existsSync(join(dir, 'fake-bin'))).toBe(false);
  });

  it('errors when the platform has no asset', async () => {
    const dir = freshDir();
    const def = defFor('', undefined, { kind: 'binary', version: '1.0.0', binRelPath: 'fake-bin', assets: {} });
    const frames = await collect(installBinaryServer(def, dir));
    expect(frames.at(-1)!.phase).toBe('error');
    expect((frames.at(-1) as { message: string }).message).toMatch(/no binary asset/);
  });
});
