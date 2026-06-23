/**
 * Shared base for Vite-template scaffolders (React+TS, Vue+TS, and future
 * frameworks that ship via `npm create vite@latest`).
 *
 * DRY: the only real difference between react-ts and vue-ts is the
 * `--template` argument to `create-vite`. Everything else — writing
 * `vite.config.ts` with the proxy-aware HMR config, `npm install`,
 * launching the dev server, polling the port — is identical.
 *
 * To add a new Vite template, subclass and set `stack` + `viteTemplate`.
 */

import type { IScaffolder, ScaffoldContext } from './scaffolder-port.js';
import type { SandboxStack, ViteStampContribution } from '../types.js';
import { POLL_INTERVAL_MS, probeContainerReady, sleep, truncate } from './ready-probe.js';
import { installPlaywrightTestClient } from './playwright-bootstrap.js';

export interface ViteScaffolderOptions {
  stack: SandboxStack;
  /** `--template` argument for `create-vite` (e.g. `react-ts`, `vue-ts`). */
  viteTemplate: string;
  /** Total time budget from `npm create` to "dev server listening". */
  readyTimeoutMs?: number;
  /**
   * When true, after `npm install` completes the scaffolder will install
   * `@playwright/cli`, `@playwright/test`, the chromium browser, and a
   * default `playwright.config.ts`. Adds ~1–3 minutes to first boot but
   * makes the QA agent immediately functional in this sandbox.
   *
   * Default `false` to keep boot time predictable for non-QA sessions.
   * Toggle per session by subclassing or by passing the flag through
   * the scaffolder factory (env var or builder config in phase 2).
   */
  includeE2e?: boolean;
}

const READY_TIMEOUT_DEFAULT_MS = 180_000;

export abstract class ViteScaffolderBase implements IScaffolder {
  readonly stack: SandboxStack;
  protected readonly viteTemplate: string;
  protected readonly readyTimeoutMs: number;
  protected readonly includeE2e: boolean;

  protected constructor(options: ViteScaffolderOptions) {
    this.stack = options.stack;
    this.viteTemplate = options.viteTemplate;
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_DEFAULT_MS;
    this.includeE2e = options.includeE2e ?? false;
  }

  async scaffold(ctx: ScaffoldContext): Promise<void> {
    const { driver, containerId, workdir, emit, sandboxId, signal } = ctx;

    // 1. Scaffold the project into a PRISTINE tmp dir first, then copy
    //    the files into the workdir. We cannot run `npm create vite`
    //    directly in `${workdir}` because `/app/node_modules` is a
    //    Docker named-volume mount point — so `readdirSync('/app')`
    //    always returns `['node_modules']` and create-vite's "target
    //    directory not empty" check kicks in. `--overwrite` does NOT
    //    save us: its `emptyDir` helper tries to `rmSync` the mount
    //    point and either throws EBUSY or silently skips scaffolding.
    //
    //    Scaffolding into `/tmp` (a container-local tmpfs, unaffected
    //    by any bind-mount or named volume) sidesteps both problems.
    //    We then `cp -a` everything across; `node_modules` stays
    //    untouched on the volume because the template doesn't ship
    //    one.
    emit({
      kind: 'step',
      sandboxId,
      step: 'scaffolding',
      message: `Scaffolding ${this.viteTemplate} via npm create vite…`,
    });
    const scaffoldCmd = [
      'rm -rf /tmp/mcp-scaffold',
      'mkdir -p /tmp/mcp-scaffold',
      `cd /tmp/mcp-scaffold && npm create vite@latest project -- --template ${this.viteTemplate}`,
      // `.` trailing + `/.` source copies hidden files (.gitignore etc.)
      // without nesting the `project/` dir. `-a` preserves mode/owner.
      `cp -a /tmp/mcp-scaffold/project/. ${workdir}/`,
      'rm -rf /tmp/mcp-scaffold',
    ].join(' && ');
    const scaffoldRes = await driver.exec(containerId, scaffoldCmd, {
      // cwd is irrelevant — the command `cd`s itself.
      cwd: undefined,
      timeoutMs: 120_000,
      signal,
      env: { CI: '1' },
    });
    if (scaffoldRes.exitCode !== 0) {
      throw new Error(
        `scaffold failed (exit ${scaffoldRes.exitCode}): ${truncate(scaffoldRes.stderr || scaffoldRes.stdout, 800)}`,
      );
    }

    // Verify the scaffold actually landed: an exit-0 create-vite that
    // nevertheless skipped file writes (seen in past regressions where
    // `--overwrite` was silently ignored) produced a misleading
    // "npm install ENOENT package.json" downstream. Fail fast here
    // with a clear message instead.
    const verifyRes = await driver.exec(
      containerId,
      `test -f ${workdir}/package.json`,
      { cwd: undefined, timeoutMs: 5_000 },
    );
    if (verifyRes.exitCode !== 0) {
      const lsRes = await driver.exec(containerId, `ls -la ${workdir}`, {
        cwd: undefined,
        timeoutMs: 5_000,
      });
      throw new Error(
        `scaffold finished without writing ${workdir}/package.json. ` +
          `Directory listing:\n${truncate(lsRes.stdout, 800)}`,
      );
    }

    // 2. Overwrite vite.config with proxy-aware HMR settings. Without
    //    this, Vite's HMR WebSocket dials the raw container port from
    //    the browser (which doesn't have that port exposed — the
    //    dashboard reaches the sandbox through the API proxy's
    //    `/preview/:sessionId/` prefix).
    const viteConfig = renderViteConfig({
      base: ctx.previewPathPrefix,
      hmrPath: `${ctx.previewPathPrefix.replace(/\/$/, '')}/@vite/hmr`,
      devPort: ctx.devServerPort,
      stamp: this.viteStampContribution(),
    });
    await driver.writeFile(containerId, `${workdir}/vite.config.ts`, viteConfig, {
      recursive: true,
    });

    // 3. Install deps. The pre-warmed base image ships the common
    //    tarballs in the npm cache (see docker/sandbox-node/Dockerfile),
    //    so this is typically <10s on warm cache.
    emit({
      kind: 'step',
      sandboxId,
      step: 'installing-deps',
      message: 'Installing dependencies (npm install)…',
    });
    const installRes = await driver.exec(
      containerId,
      'npm install --no-audit --no-fund --loglevel=error',
      { cwd: workdir, timeoutMs: 300_000, signal },
    );
    if (installRes.exitCode !== 0) {
      throw new Error(
        `npm install failed (exit ${installRes.exitCode}): ${truncate(installRes.stderr || installRes.stdout, 800)}`,
      );
    }

    // 3.5. Stack-specific post-install hook (Playwright bootstrap by
    //      default; Builder scaffolders override to add Tailwind/shadcn +
    //      the source-stamp plugin/inspector). Runs after `npm install`
    //      and before the dev server launches.
    await this.afterInstall(ctx);

    // 4. Launch dev server in the background. We detach via `nohup ... &`
    //    so the `exec` call returns immediately; the server keeps running
    //    attached to the container's pid 1.
    emit({
      kind: 'step',
      sandboxId,
      step: 'starting-dev-server',
      message: `Starting dev server on port ${ctx.devServerPort}…`,
    });
    const cmd = `nohup npm run dev -- --host 0.0.0.0 --port ${ctx.devServerPort} > /tmp/dev-server.log 2>&1 &`;
    const spawnRes = await driver.exec(containerId, cmd, {
      cwd: workdir,
      timeoutMs: 10_000,
      signal,
    });
    if (spawnRes.exitCode !== 0) {
      throw new Error(`failed to launch dev server: ${spawnRes.stderr || spawnRes.stdout}`);
    }

    // 5. Poll the host-side mapped port until the dev server answers.
    //    Total budget = `readyTimeoutMs` from the start of scaffolding.
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('scaffold aborted');
      // `isPortListening` internally uses a 1s probe; no extra sleep on
      // the successful path.
      if (await probeContainerReady(ctx)) return;
      await sleep(POLL_INTERVAL_MS);
    }
    // On timeout, surface a slice of the dev-server log to help debugging.
    const tailRes = await driver.exec(containerId, 'tail -n 50 /tmp/dev-server.log || true', {
      cwd: workdir,
      timeoutMs: 5_000,
    });
    throw new Error(
      `dev server did not open port ${ctx.devServerPort} within ${this.readyTimeoutMs}ms.\n${tailRes.stdout}`,
    );
  }

  /**
   * Stack-specific post-install steps. Runs after `npm install`, before
   * the dev server launches. Default impl preserves the legacy Playwright
   * Agent CLI bootstrap (non-fatal: a failed sub-step logs a warning and
   * lets the dev server boot anyway — the QA agent recovers via
   * `run_command` on first use).
   *
   * `ctx.includeE2e` (set per-session by the manager from
   * `role_assignments`) overrides the construct-time `this.includeE2e`
   * (set globally via env var fallback). Builder scaffolders override
   * this hook to add Tailwind/shadcn + the source-stamp plugin/inspector.
   */
  protected async afterInstall(ctx: ScaffoldContext): Promise<void> {
    const includeE2e = ctx.includeE2e ?? this.includeE2e;
    if (includeE2e) {
      await installPlaywrightTestClient({
        driver: ctx.driver,
        containerId: ctx.containerId,
        workdir: ctx.workdir,
        sandboxId: ctx.sandboxId,
        emit: ctx.emit,
        devServerPort: ctx.devServerPort,
        signal: ctx.signal,
      });
    }
  }

  /**
   * Source-stamp contribution spliced into the generated `vite.config.ts`.
   * Default `undefined` keeps the config byte-identical to the legacy
   * output. Builder scaffolders override this to inject the framework's
   * `data-mcp-loc` stamping plugin that powers element selection.
   */
  protected viteStampContribution(): ViteStampContribution | undefined {
    return undefined;
  }
}

/**
 * Rendered once by the scaffolder on first provision, and again by
 * `SandboxManager.restartDevServer()` when the user asks us to recover
 * from a corrupted vite.config (agent overwrote it). Exported so the
 * two call sites stay byte-identical — they MUST, otherwise restart
 * silently diverges from the canonical config.
 */
export function renderViteConfig(opts: {
  base: string;
  hmrPath: string;
  devPort: number;
  /**
   * Optional Builder-mode source-stamp contribution. When present its
   * import lines are spliced below the `vite` import and its plugin
   * expressions populate a `plugins: [...]` array. When absent the output
   * is byte-identical to the legacy config (the common case).
   */
  stamp?: ViteStampContribution;
}): string {
  // Keep indentation explicit — the rendered file is read by humans in
  // the preview console when debugging.
  const base = JSON.stringify(opts.base);
  const hmrPath = JSON.stringify(opts.hmrPath);
  // Stamp splices: extra imports below `vite`, and a `plugins: [...]` line
  // inside defineConfig. Empty arrays when no stamp → no `plugins` key,
  // preserving the legacy byte-for-byte output.
  const stampImports = opts.stamp?.imports ?? [];
  const pluginExprs = opts.stamp?.pluginExprs ?? [];
  const pluginsLines =
    pluginExprs.length > 0 ? [`  plugins: [${pluginExprs.join(', ')}],`] : [];
  const aliasEntries = Object.entries(opts.stamp?.resolveAlias ?? {});
  const resolveLines =
    aliasEntries.length > 0
      ? [
          `  resolve: {`,
          `    alias: {`,
          ...aliasEntries.map(([k, v]) => `      ${JSON.stringify(k)}: ${v},`),
          `    },`,
          `  },`,
        ]
      : [];
  return [
    `// ─────────────────────────────────────────────────────────────`,
    `//  DO NOT MODIFY THIS FILE FROM AGENT CODE.`,
    `//  It is regenerated by the MCP SandboxService on session start`,
    `//  and contains the proxy-aware settings that make the preview`,
    `//  iframe reachable from the dashboard:`,
    `//    - \`base\` matches the /preview/<id>/ URL prefix`,
    `//    - \`server.host: true\` binds 0.0.0.0 inside the container so`,
    `//      the host port-forward can reach Vite (otherwise Vite listens`,
    `//      only on 127.0.0.1 internal and the proxy gets ECONNREFUSED)`,
    `//    - \`server.watch.usePolling\` works around \`podman cp\` not`,
    `//      firing inotify events; without it, HMR never triggers.`,
    `//  If you need app-level Vite plugins/aliases, create a NEW file`,
    `//  (e.g. \`vite.user.config.ts\`) and merge — do not overwrite this.`,
    `// ─────────────────────────────────────────────────────────────`,
    `import { defineConfig } from 'vite';`,
    ...stampImports,
    ``,
    `export default defineConfig({`,
    `  base: ${base},`,
    ...pluginsLines,
    ...resolveLines,
    `  server: {`,
    `    // Explicit 0.0.0.0 (not shorthand \`true\`) because some Vite`,
    `    // versions treat \`host: true\` as "first non-loopback interface",`,
    `    // which can fail in rootless Podman where the container has no`,
    `    // public interface at startup.`,
    `    host: '0.0.0.0',`,
    `    port: ${opts.devPort},`,
    `    strictPort: true,`,
    `    // CRITICAL: the agent writes files into this container via`,
    `    // \`<oci-runtime> cp\`, which does NOT reliably fire inotify`,
    `    // events inside the container's overlayfs. Without polling,`,
    `    // chokidar (Vite's file watcher) never sees the new files and`,
    `    // HMR stays silent while the preview iframe shows the default`,
    `    // Vite template forever. Polling every 300ms is a tiny CPU`,
    `    // overhead compared to the UX impact of "agent said it wrote`,
    `    // files but nothing updates."`,
    `    watch: {`,
    `      usePolling: true,`,
    `      interval: 300,`,
    `      // Ignore node_modules + obvious build output to keep the`,
    `      // poll loop cheap.`,
    `      ignored: ['**/node_modules/**', '**/dist/**', '**/.git/**'],`,
    `    },`,
    `    hmr: {`,
    `      // Browser connects back through the API proxy (TLS-terminated),`,
    `      // so HMR client points at the public origin on 443 with a path`,
    `      // the proxy forwards to this container's WebSocket upgrade.`,
    `      protocol: 'wss',`,
    `      clientPort: 443,`,
    `      path: ${hmrPath},`,
    `    },`,
    `  },`,
    `});`,
    ``,
  ].join('\n');
}

