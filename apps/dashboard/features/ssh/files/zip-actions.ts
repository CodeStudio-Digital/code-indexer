/**
 * Zip / extract on both sides. Local uses the new project-scoped `files.archive`
 * / `files.extract` routes (adm-zip in main). Remote shells out over the new
 * `ssh.execCommand` — prefer `zip`/`unzip`, fall back to `tar` when the binary
 * is missing (most servers have tar even without zip). All actions prompt for a
 * name where needed and toast the outcome; the caller refreshes the pane.
 */

import type { SshConnectSpec } from '@mcp/api-bus';
import { apiCall } from '../../../lib/api-client.js';
import { execCommand } from '../api.js';
import { prompt, toast } from '../../../components/ui/prompt-dialog.js';

type TFn = (key: string, opts?: Record<string, unknown>) => string;
type Join = (dir: string, name: string) => string;

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

export async function zipLocal(projectId: number, cwd: string, names: string[], join: Join, t: TFn): Promise<boolean> {
  const base = await askZipBase(t, names.length === 1 ? names[0] : 'archive');
  if (!base) return false;
  try {
    await apiCall('files.archive', { projectId, paths: names.map((n) => join(cwd, n)), out: join(cwd, `${base}.zip`) });
    toast.success(t('files.zipDone', { name: `${base}.zip` }));
    return true;
  } catch (e) {
    toast.error(t('files.zipFailed', { reason: failReason(e) }));
    return false;
  }
}

export async function extractLocal(projectId: number, cwd: string, name: string, join: Join, t: TFn): Promise<boolean> {
  try {
    await apiCall('files.extract', { projectId, zip: join(cwd, name), dest: cwd });
    toast.success(t('files.extractDone', { name }));
    return true;
  } catch (e) {
    toast.error(t('files.zipFailed', { reason: failReason(e) }));
    return false;
  }
}

const missing = (stderr: string): boolean => /not found|command not found/i.test(stderr);

export async function zipRemote(spec: SshConnectSpec, cwd: string, names: string[], t: TFn): Promise<boolean> {
  const base = await askZipBase(t, names.length === 1 ? names[0] : 'archive');
  if (!base) return false;
  const cd = `cd ${shq(cwd)} && `;
  const list = names.map(shq).join(' ');
  try {
    let out = `${base}.zip`;
    let res = await execCommand(spec, `${cd}zip -r -q ${shq(out)} ${list}`);
    if (res.code === 127 || missing(res.stderr)) {
      out = `${base}.tar.gz`;
      res = await execCommand(spec, `${cd}tar -czf ${shq(out)} ${list}`);
    }
    if (res.code !== 0) throw new Error(res.stderr || `exit ${res.code}`);
    toast.success(t('files.zipDone', { name: out }));
    return true;
  } catch (e) {
    toast.error(t('files.zipFailed', { reason: failReason(e) }));
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
    const res = await execCommand(spec, cmd);
    if (res.code === 127 || missing(res.stderr)) throw new Error(t('files.zipMissing'));
    if (res.code !== 0) throw new Error(res.stderr || `exit ${res.code}`);
    toast.success(t('files.extractDone', { name }));
    return true;
  } catch (e) {
    toast.error(t('files.zipFailed', { reason: failReason(e) }));
    return false;
  }
}
