/**
 * Angular 19+ scaffolder.
 *
 * Pipeline (intentionally NOT extending `ViteScaffolderBase` — Angular has
 * its own CLI, its own config file, and a different dev-server command):
 *
 *   1. `ng new` into the workdir (skips git/install; we control both).
 *   2. Patch `angular.json` to set the serve options the preview proxy
 *      depends on (host=0.0.0.0, port, allowedHosts, servePath, poll).
 *   3. `npm install`.
 *   4. Launch `ng serve` in the background.
 *   5. Poll the container port until bound.
 *
 * Like the Vite scaffolders, the dev-server settings that the preview
 * proxy relies on are OWNED by this scaffolder — the agent must not
 * mutate `projects.*.architect.serve.options` at runtime. The snapshot
 * seeded into the session's project(s) (`stack-seeds.ts > ANGULAR_SEEDS
 * > "Sandbox reserved files — Angular"`) tells the agent so.
 */

import type { IScaffolder, ScaffoldContext } from './scaffolder-port.js';
import type { SandboxStack } from '../types.js';
import { POLL_INTERVAL_MS, probeContainerReady, sleep, truncate } from './ready-probe.js';

const READY_TIMEOUT_MS = 240_000; // ng new + npm install + ng serve is slower than Vite

export class AngularScaffolder implements IScaffolder {
  readonly stack: SandboxStack = 'angular';

  async scaffold(ctx: ScaffoldContext): Promise<void> {
    const { driver, containerId, workdir, emit, sandboxId, signal } = ctx;

    // 1. `ng new` into a PRISTINE /tmp dir, then copy into the workdir.
    //    We can't run `ng new --directory=.` in `${workdir}` because
    //    `/app/node_modules` is a named-volume mount point, so the
    //    Angular schematic's "directory not empty" guard fails. `ng new`
    //    has no `--overwrite`/`--force` flag, so the safest path is to
    //    scaffold in `/tmp` (container tmpfs, untouched by any mount)
    //    and `cp -a` the result across.
    emit({
      kind: 'step',
      sandboxId,
      step: 'scaffolding',
      message: 'Scaffolding Angular 19 via npx @angular/cli new…',
    });
    const scaffoldCmd = [
      'rm -rf /tmp/mcp-scaffold',
      'mkdir -p /tmp/mcp-scaffold',
      'cd /tmp/mcp-scaffold && npx --yes @angular/cli@latest new app ' +
        '--style=css --routing=true --ssr=false --skip-git --skip-install --defaults',
      `cp -a /tmp/mcp-scaffold/app/. ${workdir}/`,
      'rm -rf /tmp/mcp-scaffold',
    ].join(' && ');
    const scaffoldRes = await driver.exec(containerId, scaffoldCmd, {
      cwd: undefined,
      timeoutMs: 180_000,
      signal,
      env: { CI: '1' },
    });
    if (scaffoldRes.exitCode !== 0) {
      throw new Error(
        `angular scaffold failed (exit ${scaffoldRes.exitCode}): ${truncate(scaffoldRes.stderr || scaffoldRes.stdout, 800)}`,
      );
    }
    const verifyRes = await driver.exec(
      containerId,
      `test -f ${workdir}/package.json && test -f ${workdir}/angular.json`,
      { cwd: undefined, timeoutMs: 5_000 },
    );
    if (verifyRes.exitCode !== 0) {
      const lsRes = await driver.exec(containerId, `ls -la ${workdir}`, {
        cwd: undefined,
        timeoutMs: 5_000,
      });
      throw new Error(
        `angular scaffold finished without writing package.json/angular.json. ` +
          `Directory listing:\n${truncate(lsRes.stdout, 800)}`,
      );
    }

    // 2. Patch `angular.json` with proxy-aware serve options. We read,
    //    JSON-merge, write back — cannot just template a whole file
    //    because the generated angular.json contains per-builder details
    //    (esbuild targets, assets globs) we must preserve.
    const angularJsonPath = `${workdir}/angular.json`;
    const readRes = await driver.exec(containerId, `cat ${angularJsonPath}`, {
      cwd: workdir,
      timeoutMs: 5_000,
      signal,
    });
    if (readRes.exitCode !== 0) {
      throw new Error(`failed to read angular.json: ${truncate(readRes.stderr, 400)}`);
    }
    const patched = patchAngularJson(readRes.stdout, {
      devPort: ctx.devServerPort,
      servePath: ctx.previewPathPrefix,
    });
    await driver.writeFile(containerId, angularJsonPath, patched, { recursive: false });

    // 3. Install deps.
    emit({
      kind: 'step',
      sandboxId,
      step: 'installing-deps',
      message: 'Installing dependencies (npm install)…',
    });
    const installRes = await driver.exec(
      containerId,
      'npm install --no-audit --no-fund --loglevel=error',
      { cwd: workdir, timeoutMs: 420_000, signal },
    );
    if (installRes.exitCode !== 0) {
      throw new Error(
        `npm install failed (exit ${installRes.exitCode}): ${truncate(installRes.stderr || installRes.stdout, 800)}`,
      );
    }

    // 4. Launch `ng serve` detached. The flags here mirror what we put
    //    into angular.json so a human re-running `ng serve` by mistake
    //    doesn't hang the proxy — idempotent.
    emit({
      kind: 'step',
      sandboxId,
      step: 'starting-dev-server',
      message: `Starting ng serve on port ${ctx.devServerPort}…`,
    });
    const serveCmd =
      `nohup npx ng serve ` +
      `--host 0.0.0.0 --port ${ctx.devServerPort} ` +
      `--disable-host-check --poll=300 ` +
      `--serve-path=${JSON.stringify(ctx.previewPathPrefix)} ` +
      `> /tmp/dev-server.log 2>&1 &`;
    const spawnRes = await driver.exec(containerId, serveCmd, {
      cwd: workdir,
      timeoutMs: 10_000,
      signal,
    });
    if (spawnRes.exitCode !== 0) {
      throw new Error(`failed to launch ng serve: ${spawnRes.stderr || spawnRes.stdout}`);
    }

    // 5. Poll until bound.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('scaffold aborted');
      if (await probeContainerReady(ctx)) return;
      await sleep(POLL_INTERVAL_MS);
    }
    const tailRes = await driver.exec(containerId, 'tail -n 80 /tmp/dev-server.log || true', {
      cwd: workdir,
      timeoutMs: 5_000,
    });
    throw new Error(
      `ng serve did not open port ${ctx.devServerPort} within ${READY_TIMEOUT_MS}ms.\n${tailRes.stdout}`,
    );
  }
}

/**
 * Merge the proxy-required serve options into the CLI-generated
 * `angular.json`. We preserve every other field (builder identity,
 * build targets, styles, assets, fileReplacements…). Exported so the
 * test suite can assert the merge shape without spinning up a container.
 */
export function patchAngularJson(
  raw: string,
  opts: { devPort: number; servePath: string },
): string {
  // `ng new` produces JSON-with-comments? No — angular.json is strict JSON.
  const doc = JSON.parse(raw) as AngularJson;
  const projects = doc.projects ?? {};
  const projectNames = Object.keys(projects);
  if (projectNames.length === 0) {
    throw new Error('angular.json has no projects — scaffold output malformed');
  }
  // `ng new app --directory=.` creates a single project "app".
  for (const name of projectNames) {
    const architect = projects[name].architect ?? {};
    const serve = architect.serve ?? {};
    const options = serve.options ?? {};
    // Merge, with our keys taking precedence. `allowedHosts: 'all'` lets
    // the proxy's Host header through (dev server otherwise rejects
    // arbitrary hostnames since v16).
    architect.serve = {
      ...serve,
      options: {
        ...options,
        host: '0.0.0.0',
        port: opts.devPort,
        allowedHosts: 'all',
        servePath: opts.servePath,
        poll: 300,
      },
    };
    projects[name].architect = architect;
  }
  doc.projects = projects;
  return JSON.stringify(doc, null, 2) + '\n';
}

// Minimal shape of angular.json — we only read/write `projects.*.architect.serve.options`.
interface AngularJson {
  projects?: Record<string, AngularProject>;
  [k: string]: unknown;
}
interface AngularProject {
  architect?: Record<string, AngularTarget> & { serve?: AngularTarget };
  [k: string]: unknown;
}
interface AngularTarget {
  builder?: string;
  options?: Record<string, unknown>;
  [k: string]: unknown;
}
