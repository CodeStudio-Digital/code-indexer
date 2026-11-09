import type { Sandbox } from '../../types.js';
import type { ISandboxDriver } from '../../ports/sandbox-driver.js';
import { ensureSafeRelPath } from '../util/paths.js';
import type { SandboxRegistry } from '../state/registry.js';

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MiB

/**
 * Workspace file I/O routed through `ISandboxDriver`. Centralises the
 * three repeated guards (driver wired, sandbox present, relative path
 * safe) so HTTP callers don't re-implement validation, and unifies the
 * primary vs service code paths via a single `resolveSandbox` helper.
 */
export class WorkspaceIO {
  constructor(
    private readonly registry: SandboxRegistry,
    private readonly getDriver: () => ISandboxDriver | null,
  ) {}

  // ── path resolution

  private resolvePrimary(
    sessionId: string,
    relPath: string,
  ): { driver: ISandboxDriver; sb: Sandbox; abs: string } {
    const sb = this.registry.getPrimary(sessionId);
    if (!sb) throw new Error(`No sandbox for session ${sessionId}`);
    const driver = this.getDriver();
    if (!driver) throw new Error('SandboxManager has no driver wired');
    return { driver, sb, abs: this.absPath(sb, relPath) };
  }

  private resolveService(
    sessionId: string,
    serviceId: string,
    relPath: string,
  ): { driver: ISandboxDriver; sb: Sandbox; abs: string } {
    const sb = this.registry.getService(sessionId, serviceId);
    if (!sb) throw new Error(`No sandbox for session ${sessionId} service ${serviceId}`);
    const driver = this.getDriver();
    if (!driver) throw new Error('SandboxManager has no driver wired');
    return { driver, sb, abs: this.absPath(sb, relPath) };
  }

  private absPath(sb: Sandbox, relPath: string): string {
    const safe = ensureSafeRelPath(relPath);
    const base = sb.workdir.replace(/\/+$/, '');
    return `${base}/${safe}`;
  }

  private resolve(
    sessionId: string,
    serviceId: string | undefined,
    relPath: string,
  ): { driver: ISandboxDriver; sb: Sandbox; abs: string } {
    const isPrimary = !serviceId || serviceId === 'main';
    return isPrimary
      ? this.resolvePrimary(sessionId, relPath)
      : this.resolveService(sessionId, serviceId, relPath);
  }

  // ── operations

  /**
   * Read a workspace-relative text file. Returns `null` on ENOENT; throws
   * any other I/O failure or when the sandbox is missing.
   */
  async readText(sessionId: string, relPath: string): Promise<string | null> {
    const { driver, sb, abs } = this.resolvePrimary(sessionId, relPath);
    return this.readTextAt(driver, sb, abs);
  }

  /** Multi-service variant of `readText`. */
  async readTextOnService(
    sessionId: string,
    serviceId: string | undefined,
    relPath: string,
  ): Promise<string | null> {
    const { driver, sb, abs } = this.resolve(sessionId, serviceId, relPath);
    return this.readTextAt(driver, sb, abs);
  }

  private async readTextAt(
    driver: ISandboxDriver,
    sb: Sandbox,
    abs: string,
  ): Promise<string | null> {
    try {
      return await driver.readFile(sb.containerId, abs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such file|ENOENT|not found/i.test(msg)) return null;
      throw e;
    }
  }

  /** Write a workspace-relative text file (creates parents). */
  async writeText(sessionId: string, relPath: string, data: string): Promise<void> {
    const { driver, sb, abs } = this.resolvePrimary(sessionId, relPath);
    await driver.writeFile(sb.containerId, abs, data, { recursive: true });
  }

  async writeTextOnService(sessionId: string, serviceId: string | undefined, relPath: string, data: string): Promise<void> {
    const { driver, sb, abs } = this.resolve(sessionId, serviceId, relPath);
    await driver.writeFile(sb.containerId, abs, data, { recursive: true });
  }

  /**
   * Read a workspace-relative binary file as Buffer. Pipes through
   * `base64` because `driver.readFile` is utf-8-only — Playwright
   * trace.zip would corrupt under a naive text read. Cheap `wc -c`
   * size guard runs first to avoid loading runaway files into memory.
   */
  async readBuffer(
    sessionId: string,
    relPath: string,
    opts?: { maxBytes?: number },
  ): Promise<Buffer> {
    const { driver, sb, abs } = this.resolvePrimary(sessionId, relPath);
    return this.readBufferAt(driver, sb, abs, relPath, opts?.maxBytes ?? DEFAULT_MAX_BYTES);
  }

  /** Multi-service variant of `readBuffer`. */
  async readBufferOnService(
    sessionId: string,
    serviceId: string | undefined,
    relPath: string,
    opts?: { maxBytes?: number },
  ): Promise<Buffer> {
    const { driver, sb, abs } = this.resolve(sessionId, serviceId, relPath);
    return this.readBufferAt(driver, sb, abs, relPath, opts?.maxBytes ?? DEFAULT_MAX_BYTES);
  }

  private async readBufferAt(
    driver: ISandboxDriver,
    sb: Sandbox,
    abs: string,
    relPath: string,
    maxBytes: number,
  ): Promise<Buffer> {
    const sizeProbe = await driver.exec(sb.containerId, `wc -c < "${abs}"`, {
      cwd: undefined,
      timeoutMs: 5_000,
    });
    if (sizeProbe.exitCode !== 0) {
      throw new Error(`workspace file not readable: ${sizeProbe.stderr || sizeProbe.stdout}`);
    }
    const size = Number(sizeProbe.stdout.trim());
    if (Number.isFinite(size) && size > maxBytes) {
      throw new Error(`file ${relPath} is ${size} bytes, max ${maxBytes}`);
    }
    const b64 = await driver.exec(sb.containerId, `base64 -w0 < "${abs}"`, {
      cwd: undefined,
      timeoutMs: 30_000,
      maxOutputBytes: Math.ceil(maxBytes * 1.4) + 1024,
    });
    if (b64.exitCode !== 0) {
      throw new Error(`base64 read failed: ${b64.stderr || b64.stdout}`);
    }
    return Buffer.from(b64.stdout.trim(), 'base64');
  }

  /**
   * List every regular file under `relDir` returning paths relative to
   * that root. Powers QA report-persistence mirroring.
   */
  async listFilesOnService(
    sessionId: string,
    serviceId: string | undefined,
    relDir: string,
  ): Promise<string[]> {
    const { driver, sb, abs } = this.resolve(sessionId, serviceId, relDir);
    const probe = await driver.exec(sb.containerId, `[ -d "${abs}" ] && echo y || echo n`, {
      cwd: undefined,
      timeoutMs: 5_000,
    });
    if (probe.exitCode !== 0 || probe.stdout.trim() !== 'y') return [];

    const list = await driver.exec(sb.containerId, `find "${abs}" -type f -printf '%P\\n'`, {
      cwd: undefined,
      timeoutMs: 30_000,
      maxOutputBytes: 4 * 1024 * 1024,
    });
    if (list.exitCode !== 0) {
      throw new Error(`listWorkspaceFilesOnService failed: ${list.stderr || list.stdout}`);
    }
    return list.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  /**
   * Recursively delete a workspace-relative directory. Best-effort:
   * missing dirs are NOT an error. Refuses empty / root-equivalent paths.
   */
  async removeDirOnService(
    sessionId: string,
    serviceId: string | undefined,
    relDir: string,
  ): Promise<void> {
    if (!relDir || relDir.trim() === '') return;
    const { driver, sb, abs } = this.resolve(sessionId, serviceId, relDir);
    const r = await driver.exec(sb.containerId, `rm -rf "${abs}"`, {
      cwd: undefined,
      timeoutMs: 30_000,
    });
    if (r.exitCode !== 0 && !/no such file|not found/i.test(r.stderr || '')) {
      throw new Error(`removeWorkspaceDirOnService failed: ${r.stderr || r.stdout}`);
    }
  }
}
