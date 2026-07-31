/**
 * Owns the two process trees created by the development launcher.
 *
 * The packaged app does not use this. In development, Vite and Electron must
 * share one lifecycle: Electron closing stops Vite; Vite failing stops
 * Electron; a terminal signal stops both. Tree-aware termination is required
 * because Vite owns esbuild and Electron owns several renderer processes.
 */
import {
  killProcessTree,
  killProcessTreesSync,
  type ProcessTreeSignal,
} from '@mcp/shared/utils/process-tree.js';

interface DevChildLifecycleDeps {
  killTree?: (pid: number | undefined, signal: ProcessTreeSignal) => Promise<void>;
  killTreesSync?: (pids: ReadonlyArray<number | undefined>) => void;
}

export class DevChildLifecycle {
  readonly #electronPid: number | undefined;
  readonly #dashboardPid: number | undefined;
  readonly #killTree: NonNullable<DevChildLifecycleDeps['killTree']>;
  readonly #killTreesSync: NonNullable<DevChildLifecycleDeps['killTreesSync']>;
  #closing = false;

  constructor(
    input: {
      electronPid: number | undefined;
      dashboardPid: number | undefined;
    },
    deps: DevChildLifecycleDeps = {},
  ) {
    this.#electronPid = input.electronPid;
    this.#dashboardPid = input.dashboardPid;
    this.#killTree = deps.killTree ?? killProcessTree;
    this.#killTreesSync = deps.killTreesSync ?? killProcessTreesSync;
  }

  async electronExited(code: number | null): Promise<number | null> {
    if (!this.#beginClose()) return null;
    await this.#killTree(this.#dashboardPid, 'SIGKILL');
    return code ?? 0;
  }

  async dashboardExited(code: number | null): Promise<number | null> {
    if (!this.#beginClose()) return null;
    await this.#killTree(this.#electronPid, 'SIGKILL');
    // A renderer server disappearing while Electron is alive is always a
    // launcher failure, even when Vite happened to return zero.
    return code && code !== 0 ? code : 1;
  }

  async signalReceived(signal: 'SIGINT' | 'SIGTERM'): Promise<number | null> {
    if (!this.#beginClose()) return null;
    await Promise.all([
      this.#killTree(this.#electronPid, 'SIGKILL'),
      this.#killTree(this.#dashboardPid, 'SIGKILL'),
    ]);
    return signal === 'SIGINT' ? 130 : 143;
  }

  forceCleanup(): void {
    this.#killTreesSync([this.#electronPid, this.#dashboardPid]);
  }

  #beginClose(): boolean {
    if (this.#closing) return false;
    this.#closing = true;
    return true;
  }
}
