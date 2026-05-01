/**
 * E2B driver — remote sandbox fallback for hosts without a local OCI
 * runtime (e.g. managed app platforms that can't run Docker-in-Docker).
 *
 * Design:
 *   - Peer dependency on `e2b` (the npm SDK). We do NOT add it to
 *     `package.json` — same posture as `node-pty`: dynamically import
 *     at first use so the main bundle stays lean, and surface a clear,
 *     actionable error when the SDK is absent.
 *   - Requires `E2B_API_KEY` in the environment at the moment the
 *     first sandbox is provisioned.
 *   - Uses `@e2b/code-interpreter`-style template tags: the "node" base
 *     image with Node 20 is baked into E2B's default templates. For a
 *     custom cache-warmed template (matching our local `sandbox-node`
 *     Dockerfile), operators build & push a template via the E2B CLI
 *     and set `E2B_TEMPLATE`.
 *
 * Mapping to `ISandboxDriver`:
 *   - `create`          → `Sandbox.create(template)`
 *   - `destroy`         → `sandbox.kill()`
 *   - `exec` / `run`    → `sandbox.commands.run({...})`
 *   - `writeFile` /
 *     `readFile` /
 *     `mkdir` / `access`/
 *     `readdir`         → `sandbox.files.*`
 *   - `exportWorkdir` /
 *     `importWorkdir`   → recursive file list / per-file write; E2B
 *     doesn't expose a tar endpoint, so we implement via a recursive
 *     file tree walk and an in-memory tar packer to keep the public
 *     contract (Buffer of a tar archive) stable.
 *   - `isPortListening` → `sandbox.getHost(port)` returns a public URL.
 *     When the manager polls this, we resolve to `true` once the URL
 *     responds to a HEAD request.
 *   - `stats`           → E2B exposes usage on the control plane, not
 *     in-sandbox. Returns `null` (manager treats that as "no sample").
 *
 * We keep the entire SDK surface behind a `loadSdk()` helper so a single
 * "is it installed?" check drives every code path.
 */

import { Buffer } from 'node:buffer';
import type {
  ISandboxDriver,
  SandboxCreateSpec,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxInspectResult,
  SandboxReaddirEntry,
  SandboxStatsSample,
} from '../ports/sandbox-driver.js';

interface E2bSandbox {
  sandboxId: string;
  kill(): Promise<void>;
  commands: {
    run(
      cmd: string,
      opts?: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number; background?: boolean },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
  files: {
    write(path: string, data: string | Buffer): Promise<void>;
    read(path: string, opts?: { format?: 'text' | 'bytes' }): Promise<string | Uint8Array>;
    makeDir(path: string): Promise<boolean>;
    exists(path: string): Promise<boolean>;
    list(path: string): Promise<Array<{ name: string; type: 'dir' | 'file' }>>;
  };
  getHost(port: number): Promise<string>;
}

interface E2bModule {
  Sandbox: {
    create(
      template?: string,
      opts?: { apiKey?: string; envs?: Record<string, string>; timeoutMs?: number },
    ): Promise<E2bSandbox>;
    connect(sandboxId: string, opts?: { apiKey?: string }): Promise<E2bSandbox>;
  };
}

const MISSING_SDK_MESSAGE =
  "E2B driver selected but the 'e2b' package is not installed. " +
  "Install the peer dependency: `npm install e2b` (and set E2B_API_KEY). " +
  'Or switch to a local runtime with MCP_SANDBOX_RUNTIME=docker|podman.';

let cachedSdk: E2bModule | null = null;
async function loadSdk(): Promise<E2bModule> {
  if (cachedSdk) return cachedSdk;
  try {
    // Dynamic import + Function wrapper dodge so the TypeScript compiler
    // and the bundler never try to resolve `e2b` at build time.
    const loader = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>;
    const mod = (await loader('e2b')) as E2bModule;
    cachedSdk = mod;
    return mod;
  } catch {
    throw new Error(MISSING_SDK_MESSAGE);
  }
}

export class E2BDriver implements ISandboxDriver {
  readonly runtime = 'e2b' as const;

  /**
   * E2B returns a bag of methods per-sandbox; we need to look up the
   * handle every time the manager calls us with a containerId. Map
   * keyed by the `sandboxId` the SDK returns from `create()`.
   */
  private readonly handles = new Map<string, E2bSandbox>();
  /** Public URL per-port, cached to avoid re-resolving on every probe. */
  private readonly hostUrls = new Map<string, string>();

  async create(spec: SandboxCreateSpec): Promise<{ containerId: string }> {
    const { Sandbox } = await loadSdk();
    const template = process.env.E2B_TEMPLATE ?? 'base';
    const apiKey = process.env.E2B_API_KEY;
    if (!apiKey) {
      throw new Error(
        'E2B driver requires E2B_API_KEY in the environment. ' +
          'Get one at https://e2b.dev/dashboard and export it before starting the server.',
      );
    }
    const sbx = await Sandbox.create(template, {
      apiKey,
      envs: spec.env,
      timeoutMs: 10 * 60 * 1000,
    });
    this.handles.set(sbx.sandboxId, sbx);
    // E2B doesn't map host ports directly; it maps per-sandbox to public
    // URLs. Pre-resolve for `spec.containerPort` so the manager's
    // `isPortListening` check has an answer to probe.
    const host = await sbx.getHost(spec.containerPort);
    this.hostUrls.set(sbx.sandboxId, host);
    return { containerId: sbx.sandboxId };
  }

  async destroy(containerId: string): Promise<void> {
    const sbx = this.handles.get(containerId);
    if (!sbx) return;
    try {
      await sbx.kill();
    } finally {
      this.handles.delete(containerId);
      this.hostUrls.delete(containerId);
    }
  }

  async inspectContainer(containerId: string): Promise<SandboxInspectResult> {
    // E2B keeps an in-process handle map; "exists" ≡ "handle present".
    // Running state for E2B is opaque from the SDK, so we return
    // `running: exists` — the caller treats paused state as non-existent
    // on E2B since we don't support pause/resume there.
    const exists = this.handles.has(containerId);
    return { exists, running: exists, labels: {} };
  }

  async startContainer(_containerId: string): Promise<void> {
    // E2B Sandboxes don't support stop→start: they're pay-per-second
    // leases. The manager's pause/resume flow short-circuits E2B in
    // favor of full re-provision (via `archive` round-trip) — callers
    // of this driver should never hit this path.
    throw new Error('E2B driver does not support start; re-provision instead.');
  }

  async stopContainer(_containerId: string): Promise<void> {
    throw new Error('E2B driver does not support stop; destroy instead.');
  }

  async exec(
    containerId: string,
    command: string,
    options: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    const sbx = this.requireHandle(containerId);
    // E2B's commands.run forwards `stdin` to the spawned process when
    // present. Mirror the same semantics as the CLI driver: feed the
    // payload, EOF on close.
    const runOptions: Record<string, unknown> = {
      cwd: options.cwd,
      envs: options.env,
      timeoutMs: options.timeoutMs,
    };
    if (options.stdin !== undefined) runOptions.stdin = options.stdin;
    const result = await sbx.commands.run(command, runOptions);
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.exitCode ?? null,
      timedOut: false,
    };
  }

  async run(
    containerId: string,
    program: string,
    args: string[],
    options: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    // E2B doesn't expose a pure argv spawn; we quote args conservatively
    // and hand them to `run()`. Good enough for structured git/npm
    // invocations we actually make from tools.
    const quoted = args.map(shellQuote).join(' ');
    return this.exec(containerId, `${program}${quoted ? ' ' + quoted : ''}`, options);
  }

  async writeFile(
    containerId: string,
    absPath: string,
    data: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    const sbx = this.requireHandle(containerId);
    if (options?.recursive) {
      const slash = absPath.lastIndexOf('/');
      if (slash > 0) {
        await sbx.files.makeDir(absPath.slice(0, slash));
      }
    }
    await sbx.files.write(absPath, data);
  }

  async readFile(containerId: string, absPath: string): Promise<string> {
    const sbx = this.requireHandle(containerId);
    const result = await sbx.files.read(absPath, { format: 'text' });
    return typeof result === 'string' ? result : Buffer.from(result).toString('utf-8');
  }

  async mkdir(containerId: string, absPath: string): Promise<void> {
    const sbx = this.requireHandle(containerId);
    // E2B's makeDir is always recursive; the `recursive` option on the
    // ISandboxDriver interface is informational there.
    await sbx.files.makeDir(absPath);
  }

  async access(containerId: string, absPath: string): Promise<void> {
    const sbx = this.requireHandle(containerId);
    const exists = await sbx.files.exists(absPath);
    if (!exists) throw Object.assign(new Error(`ENOENT: ${absPath}`), { code: 'ENOENT' });
  }

  async readdir(containerId: string, absPath: string): Promise<SandboxReaddirEntry[]> {
    const sbx = this.requireHandle(containerId);
    const entries = await sbx.files.list(absPath);
    return entries.map((e) => ({
      name: e.name,
      kind: e.type === 'dir' ? 'dir' : 'file',
    }));
  }

  async isPortListening(_hostPort: number): Promise<boolean> {
    // The "hostPort" is meaningless for E2B — we mapped to a public URL
    // at create-time. Pick any live handle and probe its URL. This is
    // best-effort: if several sandboxes exist, they each have distinct
    // URLs, but the manager currently calls this only for the sandbox
    // it just created. We try every known URL and return true on any
    // successful HEAD.
    for (const url of this.hostUrls.values()) {
      try {
        const r = await fetch(url, { method: 'HEAD' });
        if (r.status < 500) return true;
      } catch {
        /* next */
      }
    }
    return false;
  }

  async stats(_containerId: string): Promise<SandboxStatsSample | null> {
    // E2B surfaces usage on the control-plane dashboard; there's no
    // per-sandbox sampler in the SDK. Returning null tells the manager
    // to skip emitting a `sandbox.stats` event this tick.
    return null;
  }

  async exportWorkdir(containerId: string, workdir: string): Promise<Buffer> {
    const sbx = this.requireHandle(containerId);
    // Lean tar packer: walk the tree, emit plain USTAR headers for each
    // regular file. Directories are implicit (mkdir at import time).
    // We deliberately DON'T ship symlinks or special files — the
    // restore path mirrors that and never tries to recreate them.
    const chunks: Buffer[] = [];
    await walk(sbx, workdir, async (absPath) => {
      const content = await sbx.files.read(absPath, { format: 'bytes' });
      const body = Buffer.from(content as Uint8Array);
      // Paths inside the tar are relative to the workdir, POSIX-style,
      // to match `docker cp <id>:<workdir> -`'s flat-root format.
      const relPath = absPath.slice(workdir.length).replace(/^\/+/, '');
      if (!relPath) return;
      chunks.push(tarHeader(relPath, body.length));
      chunks.push(body);
      const pad = (512 - (body.length % 512)) % 512;
      if (pad > 0) chunks.push(Buffer.alloc(pad));
    });
    chunks.push(Buffer.alloc(1024)); // tar EOF: two empty 512B blocks
    return Buffer.concat(chunks);
  }

  async importWorkdir(containerId: string, workdir: string, tar: Buffer): Promise<void> {
    const sbx = this.requireHandle(containerId);
    await sbx.files.makeDir(workdir);
    // Parse the USTAR records we emit in `exportWorkdir`. Third-party
    // tarballs with symlinks/long-names may not round-trip cleanly —
    // acceptable for our archive/restore use, which is symmetric.
    let offset = 0;
    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every((b) => b === 0)) break;
      const name = header.subarray(0, 100).toString('utf-8').replace(/\0.*$/, '');
      const sizeOctal = header.subarray(124, 136).toString('utf-8').replace(/[^0-7]/g, '');
      const size = parseInt(sizeOctal, 8) || 0;
      offset += 512;
      if (name) {
        const body = tar.subarray(offset, offset + size);
        const full = `${workdir.replace(/\/$/, '')}/${name}`;
        // Ensure parent dir — E2B's makeDir is recursive.
        const slash = full.lastIndexOf('/');
        if (slash > 0) await sbx.files.makeDir(full.slice(0, slash));
        await sbx.files.write(full, Buffer.from(body));
      }
      offset += size + ((512 - (size % 512)) % 512);
    }
  }

  async getContainerLogs(_containerId: string, _tail?: number): Promise<string> {
    // E2B doesn't expose a `docker logs`-equivalent in the SDK surface
    // we use; fall back to an empty string so callers degrade to just
    // the runtime state (or to the error message alone).
    return '';
  }

  async getContainerState(_containerId: string): Promise<null> {
    // No exit-code introspection on the E2B runtime — always return
    // null and let the caller format a diagnostic without it.
    return null;
  }

  // ─────────────────────────────────────────────────────────── helpers

  private requireHandle(containerId: string): E2bSandbox {
    const sbx = this.handles.get(containerId);
    if (!sbx) throw new Error(`E2B sandbox '${containerId}' not found in driver registry`);
    return sbx;
  }
}

/**
 * Minimal POSIX shell quoter. Wraps anything containing metacharacters
 * in single quotes; escapes embedded single quotes by closing, escaping,
 * and reopening. Sufficient for argv assembled from trusted code paths
 * (git tool, manager relaunch helper) — we don't use this on LLM input.
 */
function shellQuote(s: string): string {
  if (!s) return "''";
  if (/^[a-zA-Z0-9_.\-/@:=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Depth-first walk through the sandbox tree. Skips directories. */
async function walk(
  sbx: E2bSandbox,
  start: string,
  visit: (absPath: string) => Promise<void>,
): Promise<void> {
  const stack = [start];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await sbx.files.list(dir);
    for (const e of entries) {
      const full = `${dir.replace(/\/$/, '')}/${e.name}`;
      if (e.type === 'dir') stack.push(full);
      else await visit(full);
    }
  }
}

/**
 * Emit a minimal USTAR header. We fill only the fields readers care
 * about: name, mode, size, mtime, type, magic, checksum. Works with
 * GNU tar and busybox tar (the reader on the restore side).
 */
function tarHeader(name: string, size: number): Buffer {
  const buf = Buffer.alloc(512);
  buf.write(name.slice(0, 100), 0, 100, 'utf-8');
  buf.write('0000644', 100, 7, 'ascii'); // mode
  buf.write('0000000', 108, 7, 'ascii'); // uid
  buf.write('0000000', 116, 7, 'ascii'); // gid
  buf.write(size.toString(8).padStart(11, '0'), 124, 11, 'ascii');
  buf.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0'), 136, 11, 'ascii');
  buf.write('        ', 148, 8, 'ascii'); // checksum placeholder
  buf.write('0', 156, 1, 'ascii'); // regular file
  buf.write('ustar', 257, 5, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  // Checksum = sum of all bytes treating the checksum field as 8 spaces.
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  const chk = sum.toString(8).padStart(6, '0') + '\0 ';
  buf.write(chk, 148, 8, 'ascii');
  return buf;
}
