/**
 * Vite-powered API scaffolder — Hono running under Vite's dev server
 * via `@hono/vite-dev-server`. Gives the API the exact same HMR
 * pipeline the frontend stacks use (file change → Vite reloads only
 * the touched module → Hono handler swaps live without restarting
 * the process), but produces a pure backend: only JSON / fetch
 * responses, no HTML shell.
 *
 * Why Hono and not Express / Fastify? Hono's request/response types
 * are plain Web Fetch API (Request/Response), which means the same
 * app compiles unchanged to Cloudflare Workers, Deno Deploy, Bun,
 * Node, and Vercel Edge. Users who scaffold `vite-api` here can
 * later lift-and-shift the exact same source into a `cf-worker`
 * service in the same session.
 *
 * Output structure:
 *   /app
 *   ├── package.json          — hono + vite + @hono/vite-dev-server
 *   ├── tsconfig.json         — strict ESM, NodeNext
 *   ├── vite.config.ts        — proxy-aware Vite config + devServer plugin
 *   ├── src/index.ts          — minimal Hono app with /, /health, /api/echo
 *   └── docs/                 — empty; agents fill it via docs_* tools
 */

import type { IScaffolder, ScaffoldContext } from './scaffolder-port.js';
import type { SandboxStack } from '../types.js';

const READY_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 500;

export class ViteApiScaffolder implements IScaffolder {
  readonly stack: SandboxStack = 'vite-api';

  async scaffold(ctx: ScaffoldContext): Promise<void> {
    const { driver, containerId, workdir, emit, sandboxId, signal } = ctx;

    emit({
      kind: 'step',
      sandboxId,
      step: 'scaffolding',
      message: 'Scaffolding Hono + Vite API…',
    });

    // Write all files up-front, then a single `npm install` — faster
    // than running `npm create` which would prompt interactively and
    // produce a frontend-flavored template we'd have to overwrite.
    await driver.writeFile(containerId, `${workdir}/package.json`, renderPackageJson(), {
      recursive: true,
    });
    await driver.writeFile(containerId, `${workdir}/tsconfig.json`, renderTsConfig(), {
      recursive: true,
    });
    await driver.writeFile(
      containerId,
      `${workdir}/vite.config.ts`,
      renderViteApiConfig({
        base: ctx.previewPathPrefix,
        devPort: ctx.devServerPort,
      }),
      { recursive: true },
    );
    await driver.writeFile(containerId, `${workdir}/src/index.ts`, renderServerEntry(), {
      recursive: true,
    });
    await driver.writeFile(containerId, `${workdir}/.gitignore`, `node_modules\ndist\n`, {
      recursive: true,
    });

    emit({
      kind: 'step',
      sandboxId,
      step: 'installing-deps',
      message: 'Installing dependencies (hono + vite)…',
    });
    const installRes = await driver.exec(
      containerId,
      'npm install --no-audit --no-fund --loglevel=error',
      { cwd: workdir, timeoutMs: 300_000, signal },
    );
    if (installRes.exitCode !== 0) {
      throw new Error(
        `vite-api: npm install failed (exit ${installRes.exitCode}): ${truncate(installRes.stderr || installRes.stdout, 800)}`,
      );
    }

    emit({
      kind: 'step',
      sandboxId,
      step: 'starting-dev-server',
      message: `Starting Vite dev server on port ${ctx.devServerPort}…`,
    });
    // `npm run dev` runs `vite` — which reads `vite.config.ts` and
    // starts the Hono app through `@hono/vite-dev-server`. Both the
    // frontend and vite-api stacks end up with the same supervisor
    // process (`vite`), so the restart/recovery paths in
    // SandboxManager work unchanged.
    const cmd = `nohup npm run dev -- --host 0.0.0.0 --port ${ctx.devServerPort} > /tmp/dev-server.log 2>&1 &`;
    const spawnRes = await driver.exec(containerId, cmd, {
      cwd: workdir,
      timeoutMs: 10_000,
      signal,
    });
    if (spawnRes.exitCode !== 0) {
      throw new Error(
        `vite-api: failed to start dev server: ${spawnRes.stderr || spawnRes.stdout}`,
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
      `vite-api: dev server did not open port ${ctx.devServerPort} within ${READY_TIMEOUT_MS}ms.\n${tail.stdout}`,
    );
  }
}

function renderPackageJson(): string {
  // Pinned versions — the pre-warmed sandbox image prefetches these
  // tarballs. Bumping a version here = cache miss on the first
  // provision after the image is rebuilt; operators should rebuild
  // the sandbox image in lockstep.
  return JSON.stringify(
    {
      name: 'sandbox-vite-api',
      private: true,
      version: '0.1.0',
      type: 'module',
      scripts: {
        dev: 'vite',
        build: 'tsc -p tsconfig.json && vite build --ssr src/index.ts',
        start: 'node dist/index.js',
      },
      dependencies: {
        hono: '^4.12.14',
      },
      devDependencies: {
        '@hono/vite-dev-server': '^0.25.1',
        typescript: '^5.9.0',
        vite: '^8.0.8',
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
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2022', 'DOM'],
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        outDir: 'dist',
        rootDir: 'src',
        resolveJsonModule: true,
        types: ['node'],
      },
      include: ['src/**/*.ts'],
    },
    null,
    2,
  );
}

function renderServerEntry(): string {
  return [
    `import { Hono } from 'hono';`,
    ``,
    `/**`,
    ` * Hono app entry. Runs under @hono/vite-dev-server in development`,
    ` * (HMR via the Vite module graph) and compiles to a standalone`,
    ` * Node bundle for production via \`npm run build\`.`,
    ` *`,
    ` * The same \`app\` object runs unchanged on Cloudflare Workers, Deno,`,
    ` * Bun, and Vercel Edge — Hono is built on the Web Fetch API.`,
    ` */`,
    `const app = new Hono();`,
    ``,
    `app.get('/', (c) => c.json({ service: 'vite-api', ok: true }));`,
    ``,
    `app.get('/health', (c) => c.text('ok'));`,
    ``,
    `app.post('/api/echo', async (c) => {`,
    `  const body = await c.req.json().catch(() => ({}));`,
    `  return c.json({ received: body, at: new Date().toISOString() });`,
    `});`,
    ``,
    `// @hono/vite-dev-server calls \`fetch(req, env)\` on this default`,
    `// export. For Node production (npm run start) we use Hono's`,
    `// \`serve\` helper lazily — imported here so the dev bundle stays small.`,
    `export default app;`,
    ``,
  ].join('\n');
}

function renderViteApiConfig(opts: { base: string; devPort: number }): string {
  const base = JSON.stringify(opts.base);
  return [
    `// ─────────────────────────────────────────────────────────────`,
    `//  DO NOT MODIFY THIS FILE FROM AGENT CODE.`,
    `//  Managed by MCP SandboxService.`,
    `//  Adds @hono/vite-dev-server so \`vite\` serves the Hono app on`,
    `//  every request, with full Vite HMR. Runs the same handler that`,
    `//  ships to production (\`src/index.ts\`) — no duplicate entrypoint.`,
    `// ─────────────────────────────────────────────────────────────`,
    `import { defineConfig } from 'vite';`,
    `import devServer from '@hono/vite-dev-server';`,
    ``,
    `export default defineConfig({`,
    `  base: ${base},`,
    `  server: {`,
    `    host: '0.0.0.0',`,
    `    port: ${opts.devPort},`,
    `    strictPort: true,`,
    `    watch: { usePolling: true, interval: 300, ignored: ['**/node_modules/**', '**/dist/**'] },`,
    `    hmr: { protocol: 'wss', clientPort: 443, path: ${JSON.stringify(opts.base.replace(/\/$/, '') + '/@vite/hmr')} },`,
    `  },`,
    `  plugins: [`,
    `    devServer({ entry: 'src/index.ts' }),`,
    `  ],`,
    `});`,
    ``,
  ].join('\n');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + ` …[+${s.length - max} bytes]` : s;
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
