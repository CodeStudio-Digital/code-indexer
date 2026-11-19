import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeElectronSqlite } from './electron-sqlite-probe.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

function prepareElectronSqlite() {
  const electron = require('electron');
  const { version } = require('electron/package.json');
  if (probeElectronSqlite(electron, root).status === 0) {
    console.log(`SQLite is ready for Electron ${version}.`);
    return;
  }

  const manifest = require.resolve('better-sqlite3/package.json');
  const downloader = createRequire(manifest).resolve('prebuild-install/bin.js');
  const download = spawnSync(process.execPath, [downloader, '--runtime=electron', `--target=${version}`], {
    cwd: dirname(manifest),
    stdio: 'inherit',
    windowsHide: true,
  });
  if (download.error) throw download.error;
  if (download.status !== 0) {
    throw new Error(`Failed to download the SQLite prebuild for Electron ${version} (${process.platform}/${process.arch}). See the download error above.`);
  }

  const probe = probeElectronSqlite(electron, root);
  if (probe.status !== 0) {
    throw new Error(`SQLite could not load in Electron ${version}. ${probe.stderr?.trim() || probe.error?.message || ''}`.trim());
  }
  console.log(`SQLite prebuild installed and verified for Electron ${version}.`);
}

try {
  prepareElectronSqlite();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
