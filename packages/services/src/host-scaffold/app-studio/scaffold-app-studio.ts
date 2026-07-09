/**
 * App Studio — orquestra o scaffold do workspace `cf-fullstack` no host:
 * resolve `~/.mcp-code-indexer/projects/<slug>`, escreve o skeleton
 * (config + SPA + worker + shadcn + source-stamp + vite.config) e instala
 * as deps via npm (latest, como o DS Studio — o stamp é mantido contra a
 * fronteira mais nova do ecossistema).
 *
 * Como os scaffolds irmãos: nunca toca o banco, nunca apaga diretório
 * meio-escrito (destrutivo no host) — só reporta caminho + erro.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveTargetPath } from '../paths.js';
import { runHostCommand } from '../run-host-command.js';
import { NON_INTERACTIVE_ENV, INSTALL_TIMEOUT_MS } from '../templates/types.js';
import { findFreeBuilderPort, BUILDER_DEPS, BUILDER_DEV_DEPS } from '../builder-inject.js';
import { getSourceStampPlugin } from '../../sandbox/builder/source-stamp/registry.js';
import {
  POSTCSS_CONFIG_CJS,
  UTILS_TS,
  COMPONENTS_JSON,
  INDEX_CSS,
} from '../../sandbox/builder/scaffold/shadcn-files.js';
import type { AppStudioScaffoldInput, AppStudioScaffoldOutcome, AppWorkspaceFile } from './types.js';
import { buildConfigFiles } from './templates-config.js';
import { buildSrcFiles } from './templates-src.js';
import { buildWorkerFiles } from './templates-worker.js';
import { renderAppViteConfig } from './vite-config.js';

export const APP_STUDIO_DEPS = ['react', 'react-dom', 'react-router-dom', 'hono', 'better-auth', ...BUILDER_DEPS];
export const APP_STUDIO_DEV_DEPS = [
  'vite',
  '@vitejs/plugin-react',
  'typescript',
  '@types/react',
  '@types/react-dom',
  '@cloudflare/vite-plugin',
  'wrangler',
  '@cloudflare/workers-types',
  // @babel/core fica sem pin: o vite-mcp-stamp.mjs importa o namespace
  // (`import * as babelCore`) e resolve `default ?? namespace`, então roda tanto
  // no Babel 7 (CJS) quanto no 8 (ESM-only, sem default). npm resolve `latest`.
  ...BUILDER_DEV_DEPS,
];

function writeWorkspaceFiles(targetDir: string, files: AppWorkspaceFile[]): void {
  for (const f of files) {
    const abs = join(targetDir, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.contents, 'utf8');
  }
}

export async function scaffoldAppStudioWorkspace(
  input: AppStudioScaffoldInput,
): Promise<AppStudioScaffoldOutcome> {
  const { onPhase, onLog, signal } = input;
  const fail = (
    targetPath: string | null,
    message: string,
    stderrTail?: string,
  ): AppStudioScaffoldOutcome => ({ ok: false, targetPath, error: { message, stderrTail } });

  let target;
  try {
    onPhase?.({ phase: 'resolve-path', label: 'Resolving workspace location' });
    target = resolveTargetPath(input.name, { root: input.root, isNameTaken: input.isNameTaken });
  } catch (err) {
    return fail(null, err instanceof Error ? err.message : String(err));
  }
  const targetDir = target.targetPath;

  try {
    const port = await findFreeBuilderPort();
    const tpl = { slug: target.slug, appSlug: input.appSlug, appName: input.name.trim() };

    onPhase?.({ phase: 'write-skeleton', label: 'Writing workspace skeleton' });
    writeWorkspaceFiles(targetDir, [
      ...buildConfigFiles(tpl),
      ...buildSrcFiles(tpl),
      ...buildWorkerFiles(tpl),
      // Tailwind v4 + shadcn foundation (mesmos arquivos dos projetos builder).
      { path: 'postcss.config.cjs', contents: POSTCSS_CONFIG_CJS },
      { path: 'components.json', contents: COMPONENTS_JSON },
      { path: 'src/lib/utils.ts', contents: UTILS_TS },
      { path: 'src/index.css', contents: INDEX_CSS },
    ]);

    // Source-stamp (seleção de elemento do Builder): babel plugin + vite
    // plugin + inspector runtime, e o vite.config com stamp→react→cloudflare.
    onPhase?.({ phase: 'configure', label: 'Instrumenting for element selection…' });
    const stamp = getSourceStampPlugin('react-ts');
    if (!stamp) return fail(targetDir, "No Builder source-stamp for stack 'react-ts'");
    const contribution = stamp.contribution();
    writeWorkspaceFiles(
      targetDir,
      contribution.files.map((f) => ({ path: f.path, contents: f.contents })),
    );
    writeFileSync(join(targetDir, 'vite.config.ts'), renderAppViteConfig(contribution.vite, port), 'utf8');

    const run = (label: string, phase: string, args: string[]) => {
      onPhase?.({ phase, label });
      return runHostCommand({
        program: 'npm',
        args,
        cwd: targetDir,
        env: NON_INTERACTIVE_ENV,
        timeoutMs: INSTALL_TIMEOUT_MS,
        signal,
        onLog,
      });
    };

    const dep = await run('Installing dependencies…', 'install-deps', [
      'install', '--no-audit', '--no-fund', '--loglevel=error', ...APP_STUDIO_DEPS,
    ]);
    if (!dep.ok) return fail(targetDir, `Dependency install failed (exit ${dep.exitCode})`, dep.stderrTail);
    const dev = await run('Installing dev dependencies…', 'install-dev-deps', [
      'install', '--no-audit', '--no-fund', '--loglevel=error', '-D', ...APP_STUDIO_DEV_DEPS,
    ]);
    if (!dev.ok) return fail(targetDir, `Dev dependency install failed (exit ${dev.exitCode})`, dev.stderrTail);

    return { ok: true, targetPath: targetDir, slug: target.slug, name: target.name, port };
  } catch (err) {
    return fail(targetDir, err instanceof Error ? err.message : String(err));
  }
}
