/**
 * Pre-bakes Tailwind + a minimal shadcn/ui setup into a freshly-scaffolded
 * React project. Installs the runtime deps then writes the config files
 * directly (no interactive `npx shadcn init`). Individual UI components are
 * added on demand later by the agent — this only lays the foundation so
 * `@/lib/utils` + the design tokens exist and `npx shadcn add` will work.
 *
 * Non-fatal by contract: callers run this inside `afterInstall`, and a
 * failure here should surface as a clear log line, not abort the whole
 * provision (the dev server can still boot with plain CSS).
 */
import type { ScaffoldContext } from '../../scaffolders/scaffolder-port.js';
import {
  TAILWIND_CONFIG_CJS,
  POSTCSS_CONFIG_CJS,
  UTILS_TS,
  COMPONENTS_JSON,
  INDEX_CSS,
} from './shadcn-files.js';

// `@babel/core` powers the dev-only element-selection stamp Vite plugin
// (`.mcp/vite-mcp-stamp.mjs`); plugin-react v6 (oxc) no longer brings Babel.
const DEV_DEPS = ['@babel/core', 'tailwindcss@3', 'postcss', 'autoprefixer', 'tailwindcss-animate'];
const DEPS = ['class-variance-authority', 'clsx', 'tailwind-merge', 'lucide-react'];

export async function installTailwindShadcn(ctx: ScaffoldContext): Promise<void> {
  const { driver, containerId, workdir, emit, sandboxId } = ctx;

  emit({
    kind: 'step',
    sandboxId,
    step: 'installing-deps',
    message: 'Installing Tailwind + shadcn/ui foundation…',
  });

  const install = await driver.exec(
    containerId,
    `npm install --no-audit --no-fund --loglevel=error ${DEPS.join(' ')} && ` +
      `npm install -D --no-audit --no-fund --loglevel=error ${DEV_DEPS.join(' ')}`,
    { cwd: workdir, timeoutMs: 300_000, signal: ctx.signal },
  );
  if (install.exitCode !== 0) {
    throw new Error(
      `Tailwind/shadcn install failed (exit ${install.exitCode}): ${install.stderr || install.stdout}`.slice(
        0,
        800,
      ),
    );
  }

  // Config files. `recursive` creates `src/lib/` for utils.ts.
  const writes: Array<[string, string]> = [
    ['tailwind.config.cjs', TAILWIND_CONFIG_CJS],
    ['postcss.config.cjs', POSTCSS_CONFIG_CJS],
    ['components.json', COMPONENTS_JSON],
    ['src/lib/utils.ts', UTILS_TS],
    ['src/index.css', INDEX_CSS],
  ];
  for (const [rel, contents] of writes) {
    await driver.writeFile(containerId, `${workdir}/${rel}`, contents, { recursive: true });
  }
}
