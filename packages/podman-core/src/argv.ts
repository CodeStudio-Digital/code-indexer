/**
 * Pure argv builders for container + image subcommands. Every function returns
 * a discrete argv array (NO shell string) so callers can hand it straight to
 * `ctx.exec.run('podman', argv)` or `IShellPort.run('podman', argv)` without
 * any quoting. Object subcommands (volume/network/pod/compose) live in
 * `argv-objects.ts`. Keep these total functions — no I/O, no env reads.
 */
import type { RunSpec } from './types.js';

/** `podman version --format json` — liveness/probe. */
export function versionArgs(): string[] {
  return ['version', '--format', 'json'];
}

// ───────────────────────────────────────────────────────────── containers

export function psArgs(opts: { all?: boolean } = {}): string[] {
  return ['ps', ...(opts.all ? ['-a'] : []), '--format', 'json'];
}

/** Assemble a `podman run` from a {@link RunSpec}. Order is stable for tests. */
export function runArgs(spec: RunSpec): string[] {
  const args = ['run'];
  if (spec.detach) args.push('-d');
  if (spec.remove) args.push('--rm');
  if (spec.name) args.push('--name', spec.name);
  for (const p of spec.ports ?? []) args.push('-p', p);
  for (const [k, v] of Object.entries(spec.env ?? {})) args.push('-e', `${k}=${v}`);
  for (const v of spec.volumes ?? []) args.push('-v', v);
  if (spec.workdir) args.push('-w', spec.workdir);
  if (spec.network) args.push('--network', spec.network);
  for (const [k, v] of Object.entries(spec.labels ?? {})) args.push('--label', `${k}=${v}`);
  args.push(...(spec.extraArgs ?? []));
  args.push(spec.image);
  args.push(...(spec.command ?? []));
  return args;
}

export function pauseArgs(id: string): string[] {
  return ['pause', id];
}

export function unpauseArgs(id: string): string[] {
  return ['unpause', id];
}

export function startArgs(id: string): string[] {
  return ['start', id];
}

export function stopArgs(id: string, graceSeconds?: number): string[] {
  return ['stop', ...(graceSeconds != null ? ['-t', String(graceSeconds)] : []), id];
}

export function rmArgs(id: string, opts: { force?: boolean; volumes?: boolean } = {}): string[] {
  return ['rm', ...(opts.force ? ['-f'] : []), ...(opts.volumes ? ['-v'] : []), id];
}

export function logsArgs(id: string, opts: { tail?: number } = {}): string[] {
  return ['logs', ...(opts.tail != null ? ['--tail', String(opts.tail)] : []), id];
}

/** `podman inspect <target>` — works for containers, images, volumes, networks. */
export function inspectArgs(target: string): string[] {
  return ['inspect', target];
}

// ───────────────────────────────────────────────────────────────── images

export function imagesArgs(): string[] {
  return ['images', '--format', 'json'];
}

export function pullArgs(reference: string): string[] {
  return ['pull', reference];
}

export interface BuildOpts {
  tag: string;
  /** Path to the Dockerfile/Containerfile (`-f`). */
  file?: string;
  /** Build context directory (defaults to `.`). */
  context?: string;
  noCache?: boolean;
  buildArgs?: Record<string, string>;
}

export function buildArgs(opts: BuildOpts): string[] {
  const args = ['build', '-t', opts.tag];
  if (opts.file) args.push('-f', opts.file);
  if (opts.noCache) args.push('--no-cache');
  for (const [k, v] of Object.entries(opts.buildArgs ?? {})) args.push('--build-arg', `${k}=${v}`);
  args.push(opts.context ?? '.');
  return args;
}

export function rmiArgs(reference: string, opts: { force?: boolean } = {}): string[] {
  return ['rmi', ...(opts.force ? ['-f'] : []), reference];
}

export function tagArgs(source: string, target: string): string[] {
  return ['tag', source, target];
}
