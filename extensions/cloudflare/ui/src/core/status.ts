/**
 * Shared connection/project status: cf_detect (project classification) and
 * cf_whoami (token validity + accounts). Cached per mount; `subscribe` lets
 * the shell header and the home view both repaint after a refresh.
 */
import { call, detailsOf, rowsOf } from './api.js';
import { cache, type AccountInfo, type DetectInfo } from './state.js';

const listeners: Array<() => void> = [];

export function subscribeStatus(fn: () => void): void {
  listeners.push(fn);
}

function notify(): void {
  for (const fn of listeners) fn();
}

export async function fetchDetect(force = false): Promise<DetectInfo> {
  if (cache.detect && !force) return cache.detect;
  let info: DetectInfo = { isCloudflare: false, deployKind: null };
  try {
    const r = await call('cf_detect');
    const d = detailsOf(r) as {
      isCloudflare?: boolean;
      deployKind?: DetectInfo['deployKind'];
      workerName?: string;
      configPath?: string;
    };
    info = {
      isCloudflare: !!d.isCloudflare,
      deployKind: d.deployKind ?? null,
      workerName: d.workerName,
      configPath: d.configPath,
    };
  } catch {
    /* detection failing (no fs grant, etc.) just means: not a CF project */
  }
  cache.detect = info;
  notify();
  return info;
}

/** null = no usable token (cf_whoami failed). */
export async function fetchAccounts(force = false): Promise<AccountInfo | null> {
  if (cache.account !== undefined && !force) return cache.account;
  try {
    const r = await call('cf_whoami');
    const rows = rowsOf(r) as Array<{ id: string; name: string; selected?: boolean }>;
    const selected = rows.find((a) => a.selected)?.id ?? null;
    cache.account = {
      rows: rows.map((a) => ({ id: a.id, name: a.name || a.id, selected: !!a.selected })),
      selected,
    };
  } catch {
    cache.account = null;
  }
  notify();
  return cache.account;
}

export function connectionState(): 'unknown' | 'connected' | 'no-token' {
  if (cache.account === undefined) return 'unknown';
  return cache.account === null ? 'no-token' : 'connected';
}
