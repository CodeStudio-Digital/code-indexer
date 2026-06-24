/**
 * Minimal OpenSSH `~/.ssh/config` parser — pure, no I/O (so it's unit-testable).
 * Extracts concrete `Host` blocks (skips wildcard patterns like `Host *`) and the
 * handful of keywords we map onto a saved host: HostName, User, Port, IdentityFile,
 * ProxyJump. Keywords are case-insensitive; `=` and whitespace separators are both
 * accepted. Unknown keywords are ignored.
 */

export interface ParsedSshConfigHost {
  /** The first concrete alias in the `Host` line (used as the label). */
  alias: string;
  hostName: string;
  user?: string;
  port?: number;
  identityFile?: string;
  /** ProxyJump target alias (resolved to a saved jump host by the caller, best-effort). */
  proxyJump?: string;
}

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WILDCARD = /[*?!]/;

/** Read + parse the user's `~/.ssh/config`. Returns [] if it doesn't exist. */
export async function readSshConfig(): Promise<ParsedSshConfigHost[]> {
  try {
    const text = await readFile(join(homedir(), '.ssh', 'config'), 'utf8');
    return parseSshConfig(text);
  } catch {
    return []; // missing / unreadable → nothing to import
  }
}

/** Split a config line into `[keyword, value]`, honoring `Key value`, `Key=value`, and `Key = value`. */
function splitLine(line: string): [string, string] | null {
  const trimmed = line.replace(/#.*$/, '').trim(); // strip comments
  if (!trimmed) return null;
  // keyword, then an optional `=` and/or whitespace separator, then the value.
  const m = trimmed.match(/^([^\s=]+)\s*(?:=\s*)?(.*)$/);
  if (!m) return [trimmed.toLowerCase(), ''];
  return [m[1].toLowerCase(), m[2].trim()];
}

export function parseSshConfig(text: string): ParsedSshConfigHost[] {
  const out: ParsedSshConfigHost[] = [];
  let current: ParsedSshConfigHost | null = null;
  const flush = (): void => {
    if (current) out.push(current); // HostName may be empty → defaulted to alias below
    current = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const kv = splitLine(raw);
    if (!kv) continue;
    const [key, value] = kv;
    if (key === 'host') {
      flush();
      // A Host line can list several patterns; take the first concrete (non-wildcard) one.
      const alias = value.split(/\s+/).find((a) => a && !WILDCARD.test(a));
      current = alias ? { alias, hostName: '' } : null;
      continue;
    }
    if (!current) continue;
    switch (key) {
      case 'hostname':
        current.hostName = value;
        break;
      case 'user':
        current.user = value;
        break;
      case 'port': {
        const p = Number(value);
        if (Number.isInteger(p) && p > 0 && p < 65536) current.port = p;
        break;
      }
      case 'identityfile':
        current.identityFile = value;
        break;
      case 'proxyjump':
        // `none` disables it; take the nearest hop if a chain is given.
        if (value && value.toLowerCase() !== 'none') current.proxyJump = value.split(/[\s,]+/)[0];
        break;
    }
  }
  flush();
  // Default HostName to the alias when omitted (OpenSSH does the same).
  return out.map((h) => (h.hostName ? h : { ...h, hostName: h.alias }));
}
