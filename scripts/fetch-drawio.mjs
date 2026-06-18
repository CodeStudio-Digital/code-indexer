#!/usr/bin/env node
/**
 * Vendor the self-hosted draw.io editor webapp into
 * `apps/http-api/vendor/drawio/` (served at /drawio/* — see VENDOR.md there).
 *
 * Downloads a pinned jgraph/drawio source tarball and extracts its
 * `src/main/webapp/` into the vendor dir. Uses the system `tar` (present on
 * Windows 10+, macOS, Linux) to avoid a tar dependency.
 *
 *   pnpm drawio:fetch                  # pinned DEFAULT_VERSION
 *   DRAWIO_VERSION=24.7.17 pnpm drawio:fetch
 */
import { mkdtemp, rm, cp, readdir } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const DEFAULT_VERSION = '30.0.4';
const version = (process.env.DRAWIO_VERSION ?? DEFAULT_VERSION).replace(/^v/, '');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(repoRoot, 'apps', 'http-api', 'vendor', 'drawio');
const url = `https://github.com/jgraph/drawio/archive/refs/tags/v${version}.tar.gz`;

async function main() {
  console.log(`[drawio] fetching v${version} …`);
  const work = await mkdtemp(path.join(tmpdir(), 'drawio-'));
  const tarball = path.join(work, 'drawio.tar.gz');
  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${res.statusText} (${url})`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tarball));

    console.log('[drawio] extracting …');
    // Run tar from inside the work dir with RELATIVE names — a Windows path
    // like `C:\…` in the args makes GNU tar treat `C:` as a remote host
    // ("Cannot connect to C:"). cwd + relative sidesteps the colon entirely.
    const ex = spawnSync('tar', ['-xzf', 'drawio.tar.gz'], { cwd: work, stdio: 'inherit' });
    if (ex.status !== 0) throw new Error('tar extraction failed — is `tar` on PATH?');

    const webapp = path.join(work, `drawio-${version}`, 'src', 'main', 'webapp');
    if (!existsSync(path.join(webapp, 'index.html'))) {
      throw new Error(`expected webapp not found at ${webapp}`);
    }

    // Replace the vendor contents but keep VENDOR.md.
    for (const entry of await readdir(vendorDir)) {
      if (entry === 'VENDOR.md') continue;
      await rm(path.join(vendorDir, entry), { recursive: true, force: true });
    }
    await cp(webapp, vendorDir, { recursive: true });
    console.log(`[drawio] installed into ${path.relative(repoRoot, vendorDir)}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`[drawio] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
