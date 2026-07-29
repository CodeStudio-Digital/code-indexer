import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireMaintenanceLock,
  ensureSafeSessionStoragePath,
  assertSessionStorageRootAvailable,
  findBlockingProcesses,
  type ProcessInfo,
} from '../guards.js';

const processInfo = (
  pid: number,
  name: string,
  commandLine: string,
  parentPid?: number,
): ProcessInfo => ({ pid, name, commandLine, parentPid });
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('offline process guard', () => {
  it('blocks unrelated CodeStudio, Electron, worker, agent and sandbox processes', () => {
    const blockers = findBlockingProcesses([
      processInfo(10, 'CodeStudio.exe', 'CodeStudio.exe'),
      processInfo(11, 'electron.exe', 'electron.exe apps/electron/main.js'),
      processInfo(12, 'node.exe', 'node apps/http-api/worker.js'),
      processInfo(13, 'node.exe', 'node company-agent-worker.js'),
      processInfo(14, 'node.exe', 'node sandbox-worker.js'),
      processInfo(15, 'node.exe', 'node harmless-script.js'),
    ], 99);
    expect(blockers.map((item) => item.pid)).toEqual([10, 11, 12, 13, 14]);
  });

  it('does not block the headless migrator or its Electron helper descendants', () => {
    const blockers = findBlockingProcesses([
      processInfo(100, 'electron.exe', 'electron.exe electron-main.mjs'),
      processInfo(101, 'electron.exe', 'electron.exe --type=gpu-process', 100),
      processInfo(102, 'electron.exe', 'electron.exe --type=utility', 101),
      processInfo(200, 'electron.exe', 'electron.exe apps/electron/main.js'),
    ], 100);
    expect(blockers.map((item) => item.pid)).toEqual([200]);
  });

  it('does not mistake WebView user-agent and service-worker feature flags for an agent worker', () => {
    const blockers = findBlockingProcesses([
      processInfo(
        300,
        'msedgewebview2.exe',
        'msedgewebview2.exe --webview-exe-name=ms-teams.exe ' +
          '--enable-features=msWebView2SetUserAgentOverrideOnIframes,' +
          'msWebView2TerminateServiceWorkerWhenIdleIgnoringCdpSessions',
      ),
    ], 999);
    expect(blockers).toEqual([]);
  });

  it('recovers a regular stale maintenance lock but never steals a live one', () => {
    const root = mkdtempSync(join(tmpdir(), 'sessions-fs-lock-'));
    roots.push(root);
    const lockPath = join(root, '.sessions-fs-migrate.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 777 }));

    const lock = acquireMaintenanceLock(
      lockPath,
      join(root, 'index.db'),
      [processInfo(888, 'node.exe', 'unrelated')],
    );
    expect(existsSync(lockPath)).toBe(true);
    lock.release();
    expect(existsSync(lockPath)).toBe(false);

    writeFileSync(lockPath, JSON.stringify({ pid: 888 }));
    expect(() => acquireMaintenanceLock(
      lockPath,
      join(root, 'index.db'),
      [processInfo(888, 'node.exe', 'still-running')],
    )).toThrow('cannot acquire exclusive maintenance lock');
  });
});

describe('session storage root guard', () => {
  it('accepts a real writable directory and rejects a symlink or junction', () => {
    const root = mkdtempSync(join(tmpdir(), 'sessions-fs-root-'));
    roots.push(root);
    const realRoot = join(root, 'real');
    const linkedRoot = join(root, 'linked');
    mkdirSync(realRoot);
    symlinkSync(
      realRoot,
      linkedRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(() =>
      assertSessionStorageRootAvailable(realRoot, false),
    ).not.toThrow();
    expect(() =>
      assertSessionStorageRootAvailable(linkedRoot, false),
    ).toThrow('cannot be a symlink or junction');
  });

  it('rejects an intermediate session-root junction and creates safe descendants one level at a time', () => {
    const root = mkdtempSync(join(tmpdir(), 'sessions-fs-chain-'));
    roots.push(root);
    const realIndexer = join(root, 'real-indexer');
    const linkedIndexer = join(root, '.mcp-indexer');
    mkdirSync(realIndexer);
    symlinkSync(
      realIndexer,
      linkedIndexer,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(() =>
      ensureSafeSessionStoragePath(
        root,
        join(linkedIndexer, 'session'),
        false,
      ),
    ).toThrow('cannot contain a symlink or junction');

    rmSync(linkedIndexer, { recursive: true, force: true });
    expect(() =>
      ensureSafeSessionStoragePath(
        root,
        join(root, '.mcp-indexer', 'session'),
        true,
      ),
    ).not.toThrow();
    expect(existsSync(join(root, '.mcp-indexer', 'session'))).toBe(true);
  });

  it('rejects a dangling intermediate link during read-only validation', () => {
    const root = mkdtempSync(join(tmpdir(), 'sessions-fs-dangling-'));
    roots.push(root);
    const linkedIndexer = join(root, '.mcp-indexer');
    symlinkSync(
      join(root, 'missing-indexer'),
      linkedIndexer,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(() =>
      ensureSafeSessionStoragePath(
        root,
        join(linkedIndexer, 'session'),
        false,
      ),
    ).toThrow('cannot contain a symlink or junction');
  });
});
