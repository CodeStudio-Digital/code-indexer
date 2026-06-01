/**
 * Pure argv builders for the "object" subcommands: volumes, networks, pods and
 * compose. Split from `argv.ts` to keep each file focused and under the LOC
 * budget. Same contract: total functions, discrete argv, no I/O.
 */

// ──────────────────────────────────────────────────────────────── volumes

export function volumeLsArgs(): string[] {
  return ['volume', 'ls', '--format', 'json'];
}

export function volumeCreateArgs(
  name: string,
  opts: { driver?: string; labels?: Record<string, string> } = {},
): string[] {
  const args = ['volume', 'create'];
  if (opts.driver) args.push('-d', opts.driver);
  for (const [k, v] of Object.entries(opts.labels ?? {})) args.push('--label', `${k}=${v}`);
  args.push(name);
  return args;
}

export function volumeInspectArgs(name: string): string[] {
  return ['volume', 'inspect', name];
}

export function volumeRmArgs(name: string, opts: { force?: boolean } = {}): string[] {
  return ['volume', 'rm', ...(opts.force ? ['-f'] : []), name];
}

// ─────────────────────────────────────────────────────────────── networks

export function networkLsArgs(): string[] {
  return ['network', 'ls', '--format', 'json'];
}

export function networkCreateArgs(
  name: string,
  opts: { driver?: string; subnet?: string } = {},
): string[] {
  const args = ['network', 'create'];
  if (opts.driver) args.push('-d', opts.driver);
  if (opts.subnet) args.push('--subnet', opts.subnet);
  args.push(name);
  return args;
}

export function networkInspectArgs(name: string): string[] {
  return ['network', 'inspect', name];
}

export function networkRmArgs(name: string, opts: { force?: boolean } = {}): string[] {
  return ['network', 'rm', ...(opts.force ? ['-f'] : []), name];
}

// ──────────────────────────────────────────────────────────────────── pods

export function podPsArgs(): string[] {
  return ['pod', 'ps', '--format', 'json'];
}

export function podCreateArgs(
  name: string,
  opts: { ports?: string[]; labels?: Record<string, string> } = {},
): string[] {
  const args = ['pod', 'create', '--name', name];
  for (const p of opts.ports ?? []) args.push('-p', p);
  for (const [k, v] of Object.entries(opts.labels ?? {})) args.push('--label', `${k}=${v}`);
  return args;
}

export function podStartArgs(id: string): string[] {
  return ['pod', 'start', id];
}

export function podStopArgs(id: string, graceSeconds?: number): string[] {
  return ['pod', 'stop', ...(graceSeconds != null ? ['-t', String(graceSeconds)] : []), id];
}

export function podRmArgs(id: string, opts: { force?: boolean } = {}): string[] {
  return ['pod', 'rm', ...(opts.force ? ['-f'] : []), id];
}

// ───────────────────────────────────────────────────────────────── compose

/**
 * `podman compose` (or `podman-compose`) passthrough. `file` pins a specific
 * compose file; omit to let podman discover `compose.yaml` in the cwd.
 */
export function composeArgs(
  action: 'up' | 'down' | 'ps',
  opts: { file?: string; detach?: boolean } = {},
): string[] {
  const args = ['compose'];
  if (opts.file) args.push('-f', opts.file);
  args.push(action);
  if (action === 'up' && opts.detach) args.push('-d');
  return args;
}
