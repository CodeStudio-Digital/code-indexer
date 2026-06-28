/**
 * Cloudflare Workers scaffolder — runs the user's worker under a local
 * `wrangler dev` process. Wrangler uses Cloudflare's own `workerd`
 * runtime, so the dev experience is byte-compatible with production:
 * the same request lifecycle, the same bindings API, the same fetch
 * event handler signature. No iframe-vs-prod drift.
 *
 * Output structure:
 *   /app
 *   ├── package.json          — wrangler (dev) + typescript
 *   ├── wrangler.toml         — `name`, `main`, compat date, no bindings
 *   ├── tsconfig.json         — Worker types + ESM NodeNext
 *   ├── src/index.ts          — minimal Hono-on-Workers fetch handler
 *   └── docs/                 — empty
 *
 * Why Hono here too? Same rationale as `vite-api`: the handler is plain
 * Fetch API, so the same source can be dropped into `vite-api` later
 * or vice-versa. Keeps the surface area of the scaffolders symmetrical.
 */

import type { IScaffolder, ScaffoldContext } from './scaffolder-port.js';
import type { SandboxStack } from '../types.js';

const READY_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 500;

export class CfWorkerScaffolder implements IScaffolder {
  readonly stack: SandboxStack = 'cf-worker';

  async scaffold(ctx: ScaffoldContext): Promise<void> {
    const { driver, containerId, workdir, emit, sandboxId, signal } = ctx;

    emit({
      kind: 'step',
      sandboxId,
      step: 'scaffolding',
      message: 'Scaffolding Cloudflare Worker (wrangler dev)…',
    });

    await driver.writeFile(containerId, `${workdir}/package.json`, renderPackageJson(), {
      recursive: true,
    });
    await driver.writeFile(containerId, `${workdir}/tsconfig.json`, renderTsConfig(), {
      recursive: true,
    });
    await driver.writeFile(
      containerId,
      `${workdir}/wrangler.toml`,
      renderWranglerToml({ devPort: ctx.devServerPort }),
      { recursive: true },
    );
    await driver.writeFile(containerId, `${workdir}/src/index.ts`, renderWorkerEntry(), {
      recursive: true,
    });
    await driver.writeFile(
      containerId,
      `${workdir}/.gitignore`,
      `node_modules\n.wrangler\ndist\n`,
      { recursive: true },
    );

    emit({
      kind: 'step',
      sandboxId,
      step: 'installing-deps',
      message: 'Installing wrangler + hono…',
    });
    const installRes = await driver.exec(
      containerId,
      'npm install --no-audit --no-fund --loglevel=error',
      { cwd: workdir, timeoutMs: 300_000, signal },
    );
    if (installRes.exitCode !== 0) {
      throw new Error(
        `cf-worker: npm install failed (exit ${installRes.exitCode}): ${truncate(installRes.stderr || installRes.stdout, 800)}`,
      );
    }

    emit({
      kind: 'step',
      sandboxId,
      step: 'starting-dev-server',
      message: `Starting wrangler dev on port ${ctx.devServerPort}…`,
    });
    // Wrangler flags:
    //   --ip 0.0.0.0  → bind every interface (so the host port-forward
    //                   reaches it; default is 127.0.0.1 inside the
    //                   container, which the host mapping can't reach).
    //   --port <N>    → lock the local workerd to the sandbox dev port
    //                   so the preview URL routes correctly.
    //   --local       → local workerd, no cloudflare account needed.
    //                   Default since wrangler 3, kept explicit for
    //                   operators pinning older versions.
    //   --show-interactive-dev-session=false → disable the TTY prompt;
    //                   when stdin is closed wrangler would otherwise
    //                   spam the log with "press d to open devtools".
    const cmd =
      `nohup npx wrangler dev --ip 0.0.0.0 --port ${ctx.devServerPort} --local ` +
      `--show-interactive-dev-session=false > /tmp/dev-server.log 2>&1 &`;
    const spawnRes = await driver.exec(containerId, cmd, {
      cwd: workdir,
      timeoutMs: 10_000,
      signal,
    });
    if (spawnRes.exitCode !== 0) {
      throw new Error(
        `cf-worker: failed to launch wrangler dev: ${spawnRes.stderr || spawnRes.stdout}`,
      );
    }

    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('scaffold aborted');
      const res = await driver.exec(
        containerId,
        `ss -ltn 2>/dev/null | awk '{print $4}' | grep -E ':${ctx.devServerPort}$' >/dev/null && echo listening || echo no`,
        { cwd: workdir, timeoutMs: 2_000 },
      );
      if (/listening/.test(res.stdout)) return;
      await sleep(POLL_INTERVAL_MS);
    }
    const tail = await driver.exec(
      containerId,
      'tail -n 80 /tmp/dev-server.log || true',
      { cwd: workdir, timeoutMs: 5_000 },
    );
    throw new Error(
      `cf-worker: wrangler dev did not open port ${ctx.devServerPort} within ${READY_TIMEOUT_MS}ms.\n${tail.stdout}`,
    );
  }
}

function renderPackageJson(): string {
  return JSON.stringify(
    {
      name: 'sandbox-cf-worker',
      private: true,
      version: '0.1.0',
      type: 'module',
      scripts: {
        // Agents commonly run `npm run dev` — keep it as a shortcut,
        // though the scaffolder already started wrangler directly.
        dev: 'wrangler dev --ip 0.0.0.0 --local',
        deploy: 'wrangler deploy',
        typecheck: 'tsc --noEmit',
      },
      dependencies: {
        hono: '^4.12.27',
      },
      devDependencies: {
        '@cloudflare/workers-types': '^4.20260627.1',
        typescript: '^6.0.0',
        wrangler: '^4.105.0',
      },
    },
    null,
    2,
  );
}

function renderTsConfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ES2022',
        moduleResolution: 'Bundler',
        lib: ['ES2022'],
        types: ['@cloudflare/workers-types'],
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        resolveJsonModule: true,
      },
      include: ['src/**/*.ts'],
    },
    null,
    2,
  );
}

function renderWranglerToml(opts: { devPort: number }): string {
  // wrangler.toml is TOML, not JSON — hand-format to keep comments.
  return [
    `# ─────────────────────────────────────────────────────────────`,
    `#  Managed by MCP SandboxService. Agents may add bindings`,
    `#  (KV, D1, R2, vars, durable_objects) below, but MUST NOT`,
    `#  change \`name\`, \`main\`, or the \`[dev]\` block without also`,
    `#  updating the sandbox's dev-server port mapping.`,
    `# ─────────────────────────────────────────────────────────────`,
    `name = "sandbox-cf-worker"`,
    `main = "src/index.ts"`,
    `compatibility_date = "2026-06-01"`,
    `compatibility_flags = ["nodejs_compat"]`,
    ``,
    `[dev]`,
    `ip = "0.0.0.0"`,
    `port = ${opts.devPort}`,
    ``,
  ].join('\n');
}

function renderWorkerEntry(): string {
  return [
    `import { Hono } from 'hono';`,
    ``,
    `/**`,
    ` * Cloudflare Worker entry. Runs on workerd locally (via wrangler`,
    ` * dev) and on Cloudflare's edge in production. The Hono app below`,
    ` * is portable — the same source compiles unchanged against the`,
    ` * \`vite-api\` stack (Node + Vite) if you ever want to lift it.`,
    ` *`,
    ` * Add bindings in wrangler.toml (KV, D1, R2, vars) and type them`,
    ` * via the \`Bindings\` generic below.`,
    ` */`,
    `type Bindings = {`,
    `  // EXAMPLE_KV: KVNamespace;`,
    `  // DB: D1Database;`,
    `};`,
    ``,
    `const app = new Hono<{ Bindings: Bindings }>();`,
    ``,
    `app.get('/', (c) => c.json({ service: 'cf-worker', ok: true }));`,
    ``,
    `app.get('/health', (c) => c.text('ok'));`,
    ``,
    `app.post('/api/echo', async (c) => {`,
    `  const body = await c.req.json().catch(() => ({}));`,
    `  return c.json({ received: body, at: new Date().toISOString() });`,
    `});`,
    ``,
    `export default app;`,
    ``,
  ].join('\n');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + ` …[+${s.length - max} bytes]` : s;
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
