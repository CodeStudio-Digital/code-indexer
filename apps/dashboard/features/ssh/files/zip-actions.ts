/**
 * Zip / extract on both sides.
 *
 * LOCAL goes through `files.archiveStream` / `files.extractStream`, which run
 * the (fully synchronous) adm-zip work in a worker thread — doing it inline on
 * the Electron main process froze every window, all IPC and every PTY stream
 * for the duration of the job.
 *
 * REMOTE shells out over `ssh.execCommand` and runs entirely on the server, so
 * there is no main-thread work to move — prefer `zip`/`unzip`, fall back to
 * `tar` when the binary is missing (most servers have tar even without zip).
 */

import type { ArchiveProgress, SshConnectSpec } from '@mcp/api-bus';
import { apiStream } from '../../../lib/api-client.js';
import { execCommand } from '../api.js';
import { prompt, toast } from '../../../components/ui/prompt-dialog.js';
import type { Transfer } from './transfer-controller.js';

type TFn = (key: string, opts?: Record<string, unknown>) => string;
type Join = (dir: string, name: string) => string;
type RunArchive = (tf: Transfer, stream: AsyncIterable<ArchiveProgress>, successLabel: string) => Promise<boolean>;

/**
 * Remote archiving can legitimately run for many minutes on a big tree. The
 * exec default is 60 s, and on timeout the channel teardown does NOT reliably
 * kill the remote process — so the old code reported "failed" while `zip` kept
 * running and the archive appeared later out of nowhere.
 */
const REMOTE_ARCHIVE_TIMEOUT_MS = 30 * 60_000;

/** POSIX single-quote a shell argument (safe for arbitrary filenames). */
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** True for names we know how to extract remotely / recognise as archives. */
export function isArchive(name: string): boolean {
  return /\.(zip|tar\.gz|tgz|tar)$/i.test(name);
}

async function askZipBase(t: TFn, dflt: string): Promise<string | null> {
  const name = await prompt({
    title: t('files.zip'),
    defaultValue: dflt,
    placeholder: t('files.zipNamePh'),
    confirmLabel: t('files.zip'),
    cancelLabel: t('dialog.cancel'),
  });
  const trimmed = name?.trim();
  return trimmed ? trimmed.replace(/\.(zip|tar\.gz|tgz)$/i, '') : null;
}

const failReason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Local zip runs in a worker thread and streams progress, so the caller feeds
 * it through the same TransferBar row a file transfer uses (with a working
 * cancel button). `runArchive` owns the toasts for this path.
 */
export async function zipLocal(
  projectId: number,
  cwd: string,
  names: string[],
  join: Join,
  t: TFn,
  runArchive: RunArchive,
): Promise<boolean> {
  const base = await askZipBase(t, names.length === 1 ? names[0] : 'archive');
  if (!base) return false;
  const outName = `${base}.zip`;
  const archiveId = `zip:${join(cwd, outName)}`;
  return runArchive(
    { id: archiveId, name: outName, dir: 'zip', transferred: 0, total: 0 },
    apiStream<ArchiveProgress>('files.archiveStream', {
      projectId,
      paths: names.map((n) => join(cwd, n)),
      out: join(cwd, outName),
      archiveId,
    }),
    t('files.zipDone', { name: outName }),
  );
}

export async function extractLocal(
  projectId: number,
  cwd: string,
  name: string,
  join: Join,
  t: TFn,
  runArchive: RunArchive,
): Promise<boolean> {
  const archiveId = `unzip:${join(cwd, name)}`;
  return runArchive(
    { id: archiveId, name, dir: 'unzip', transferred: 0, total: 0 },
    apiStream<ArchiveProgress>('files.extractStream', { projectId, zip: join(cwd, name), dest: cwd, archiveId }),
    t('files.extractDone', { name }),
  );
}

const missing = (stderr: string): boolean => /not found|command not found/i.test(stderr);

/**
 * A timed-out remote exec is NOT a failure: the channel teardown does not
 * reliably kill the remote process, so the command keeps running and the
 * archive shows up later. Saying "failed" trains the user to retry and end up
 * with duplicates — say what actually happened instead.
 */
function reportRemote(e: unknown, t: TFn): void {
  const reason = failReason(e);
  if (/ssh_exec_timeout|timed? ?out/i.test(reason)) toast.info(t('files.zipStillRunning'));
  else toast.error(t('files.zipFailed', { reason }));
}

export async function zipRemote(spec: SshConnectSpec, cwd: string, names: string[], t: TFn): Promise<boolean> {
  const base = await askZipBase(t, names.length === 1 ? names[0] : 'archive');
  if (!base) return false;
  const cd = `cd ${shq(cwd)} && `;
  const list = names.map(shq).join(' ');
  const opts = { timeoutMs: REMOTE_ARCHIVE_TIMEOUT_MS };
  try {
    let out = `${base}.zip`;
    let res = await execCommand(spec, `${cd}zip -r -q ${shq(out)} ${list}`, opts);
    if (res.code === 127 || missing(res.stderr)) {
      out = `${base}.tar.gz`;
      res = await execCommand(spec, `${cd}tar -czf ${shq(out)} ${list}`, opts);
    }
    if (res.code !== 0) throw new Error(res.stderr || `exit ${res.code}`);
    toast.success(t('files.zipDone', { name: out }));
    return true;
  } catch (e) {
    reportRemote(e, t);
    return false;
  }
}

export async function extractRemote(spec: SshConnectSpec, cwd: string, name: string, t: TFn): Promise<boolean> {
  const cd = `cd ${shq(cwd)} && `;
  const lower = name.toLowerCase();
  const cmd = lower.endsWith('.zip')
    ? `${cd}unzip -o ${shq(name)}`
    : /\.(tar\.gz|tgz)$/.test(lower)
      ? `${cd}tar -xzf ${shq(name)}`
      : lower.endsWith('.tar')
        ? `${cd}tar -xf ${shq(name)}`
        : null;
  if (!cmd) {
    toast.error(t('files.unknownArchive', { name }));
    return false;
  }
  try {
    const res = await execCommand(spec, cmd, { timeoutMs: REMOTE_ARCHIVE_TIMEOUT_MS });
    if (res.code === 127 || missing(res.stderr)) throw new Error(t('files.zipMissing'));
    if (res.code !== 0) throw new Error(res.stderr || `exit ${res.code}`);
    toast.success(t('files.extractDone', { name }));
    return true;
  } catch (e) {
    reportRemote(e, t);
    return false;
  }
}
