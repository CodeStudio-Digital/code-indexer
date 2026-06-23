/**
 * Capability surfaces handed to a plugin tool handler via `ctx` — each gated by
 * a permission the plugin DECLARES in its manifest and the user APPROVES at
 * install. Every method is a thin async proxy: the worker forwards the call
 * over the reverse-RPC `host.invoke`, and the host enforces scope + grants
 * before touching disk / spawning a process / reading storage. Zero deps (no
 * zod) so a plugin bundle importing these stays lean.
 */

/**
 * Project-scoped filesystem. Relative paths resolve against the project root
 * (the tool's `cwd`); the host rejects anything escaping it (traversal,
 * absolute, drive letter). Read/write are independently gated by the declared
 * `fs.read` / `fs.write` globs. Present on `ctx` only when granted.
 */
export interface PluginFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
}

/** Result of a one-shot command. `code` is null when the process was signalled. */
export interface PluginExecResult {
  stdout: string;
  code: number | null;
}

/**
 * Run an allowlisted binary to completion in the project dir. The binary (and
 * the first arg when it is `npx`) must appear in the declared `exec.allow`
 * list. Long-running / interactive commands (live `tail`, `wrangler login`) go
 * through the UI streaming path, not here. Present on `ctx` only when granted.
 */
export interface PluginExec {
  run(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<PluginExecResult>;
}

/** Per-plugin string key-value storage. Gated by the `storage` permission. */
export interface PluginStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

/**
 * Capabilities a plugin requires — declared in the manifest, surfaced to the
 * user for approval at install, and re-checked host-side on every call. The
 * `.app.json` `permissions` block validates against this shape (see
 * `app-json.schema.ts`).
 */
export interface PluginPermissions {
  /** Glob lists scoping filesystem access, relative to the project root. */
  fs?: { read?: string[]; write?: string[] };
  /** Binaries the plugin may exec (e.g. `["npx", "wrangler"]`). */
  exec?: { allow: string[] };
  /** Whether the plugin uses per-plugin key-value storage. */
  storage?: boolean;
}
