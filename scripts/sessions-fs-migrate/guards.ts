import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

export interface ProcessInfo {
  pid: number;
  parentPid?: number;
  name: string;
  commandLine: string;
}

export interface MaintenanceLock {
  path: string;
  release(): void;
}

const exactExecutableBlocklist = new Set([
  'codestudio.exe',
  'codestudio',
  'electron.exe',
  'electron',
]);

const commandLineBlocklist = [
  /apps[\\/]electron(?:[\\/]|\.|$)/i,
  /apps[\\/]http-api(?:[\\/]|\.|$)/i,
  /apps[\\/]mcp-server(?:[\\/]|\.|$)/i,
  /dbwriter[\\/]worker/i,
  /(?:^|[ "'\\/])company[^ "'\\]*(?:worker|agent)(?:\.[cm]?[jt]s|\.exe)?(?=$|[ "'\\/])/i,
  /(?:^|[ "'\\/])(?:sandbox|agent)[^ "'\\]*worker(?:\.[cm]?[jt]s|\.exe)?(?=$|[ "'\\/])/i,
] as const;

export function findBlockingProcesses(
  processes: readonly ProcessInfo[],
  selfPid = process.pid,
): ProcessInfo[] {
  const byPid = new Map(processes.map((item) => [item.pid, item]));
  const belongsToCurrentElectron = (item: ProcessInfo): boolean => {
    const visited = new Set<number>();
    let cursor: ProcessInfo | undefined = item;
    while (cursor && !visited.has(cursor.pid)) {
      if (cursor.pid === selfPid) return true;
      visited.add(cursor.pid);
      cursor = cursor.parentPid ? byPid.get(cursor.parentPid) : undefined;
    }
    return false;
  };
  return processes.filter((item) => {
    if (belongsToCurrentElectron(item)) return false;
    const normalizedName = item.name.trim().toLowerCase();
    if (exactExecutableBlocklist.has(normalizedName)) return true;
    return commandLineBlocklist.some((pattern) => pattern.test(item.commandLine));
  });
}

function parseWindowsProcessJson(raw: string): ProcessInfo[] {
  const value = JSON.parse(raw) as unknown;
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return rows.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    const pid = Number(row.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) return [];
    return [{
      pid,
      parentPid: Number.isInteger(Number(row.ParentProcessId))
        ? Number(row.ParentProcessId)
        : undefined,
      name: String(row.Name ?? ''),
      commandLine: String(row.CommandLine ?? ''),
    }];
  });
}

export function listProcesses(): ProcessInfo[] {
  if (process.platform === 'win32') {
    const command =
      '$ErrorActionPreference = "Stop"; '
      + 'Get-CimInstance Win32_Process '
      + '| Select-Object ProcessId,ParentProcessId,Name,CommandLine '
      + '| ConvertTo-Json -Compress';
    const raw = execFileSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', windowsHide: true },
    );
    return parseWindowsProcessJson(raw);
  }
  const raw = execFileSync('ps', ['-axo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8' });
  return raw.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match) return [];
    return [{
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      name: match[3],
      commandLine: match[4],
    }];
  });
}

export function assertOffline(processes = listProcesses()): void {
  const blockers = findBlockingProcesses(processes);
  if (blockers.length === 0) return;
  const detail = blockers
    .slice(0, 20)
    .map((item) => `${item.pid} ${item.name} ${item.commandLine}`.trim())
    .join('\n  ');
  throw new Error(
    `offline migration refused: stop CodeStudio, Electron, API/MCP workers, agents and sandboxes first:\n  ${detail}`,
  );
}

export function acquireMaintenanceLock(
  lockPath: string,
  dbPath: string,
  activeProcesses?: readonly ProcessInfo[],
): MaintenanceLock {
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    const owner = existsSync(lockPath) ? readFileSync(lockPath, 'utf8').slice(0, 2048) : '';
    let stale = false;
    if (activeProcesses && owner) {
      try {
        const parsed = JSON.parse(owner) as { pid?: unknown };
        const ownerPid = Number(parsed.pid);
        stale = Number.isSafeInteger(ownerPid)
          && ownerPid > 0
          && !activeProcesses.some((process) => process.pid === ownerPid);
      } catch {
        stale = false;
      }
    }
    if (!stale) {
      throw new Error(
        `cannot acquire exclusive maintenance lock ${lockPath}${owner ? `; current owner: ${owner}` : ''}`,
        { cause: error },
      );
    }
    const stat = lstatSync(lockPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`refusing to recover non-file maintenance lock: ${lockPath}`);
    }
    rmSync(lockPath, { force: false });
    fd = openSync(lockPath, 'wx', 0o600);
  }

  let released = false;
  try {
    writeFileSync(fd, JSON.stringify({
      pid: process.pid,
      db_path: resolve(dbPath),
      acquired_at: new Date().toISOString(),
    }) + '\n', 'utf8');
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(lockPath, { force: true });
    throw error;
  }

  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      closeSync(fd);
      rmSync(lockPath, { force: true });
    },
  };
}

export function assertWritableDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
  const probe = resolve(path, `.sessions-fs-probe-${process.pid}-${Date.now()}`);
  let fd: number | undefined;
  try {
    fd = openSync(probe, 'wx', 0o600);
    writeFileSync(fd, 'ok', 'utf8');
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(probe, { force: true });
  }
}

/**
 * Match the runtime SessionLocator boundary exactly: an owner root must be a
 * real, writable directory. Accepting a symlink/junction here would let the
 * offline cutover publish bundles that the new application then refuses to
 * open.
 */
export function assertSessionStorageRootAvailable(
  path: string,
  writeProbe: boolean,
): void {
  if (!existsSync(path)) {
    throw new Error(`session storage root is absent: ${path}`);
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(
      `session storage root cannot be a symlink or junction: ${path}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`session storage root is not a directory: ${path}`);
  }
  accessSync(path, constants.R_OK | constants.W_OK);
  if (writeProbe) assertWritableDirectory(path);
}

/**
 * Validate every path component below a trusted owner root. In apply mode the
 * missing descendants are created one level at a time; dry-run/verify mode is
 * read-only and stops at the first missing component.
 */
export function ensureSafeSessionStoragePath(
  ownerRoot: string,
  targetPath: string,
  create: boolean,
): void {
  const owner = resolve(ownerRoot);
  const target = resolve(targetPath);
  assertSessionStorageRootAvailable(owner, false);
  const rel = relative(owner, target);
  if (
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new Error(
      `session storage path escapes its owner root: owner=${owner} target=${target}`,
    );
  }
  if (rel === '') return;

  let cursor = owner;
  for (const segment of rel.split(sep)) {
    cursor = resolve(cursor, segment);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return;
      try {
        mkdirSync(cursor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      stat = lstatSync(cursor);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        `session storage path cannot contain a symlink or junction: ${cursor}`,
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(
        `session storage path component is not a directory: ${cursor}`,
      );
    }
    accessSync(cursor, constants.R_OK | constants.W_OK);
  }
}

export function availableBytes(path: string): number {
  const stats = statfsSync(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

export function assertSpace(path: string, requiredBytes: number): void {
  const available = availableBytes(path);
  if (available < requiredBytes) {
    throw new Error(
      `insufficient free space at ${path}: required=${requiredBytes} available=${available}`,
    );
  }
}

export function assertElectronAbi(): void {
  if (!process.versions.electron) {
    throw new Error(
      'the migration must run as the headless Electron main process; refusing Node ABI execution',
    );
  }
}
