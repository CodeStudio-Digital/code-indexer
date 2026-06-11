/**
 * DS Studio — orquestra o scaffold do workspace no host:
 * resolve `~/.mcp-code-indexer/projects/<slug>`, escreve o skeleton do
 * stack (react/vue por templates determinísticos; angular via CLI),
 * instala deps, instrumenta (react) e extrai o zip de import opcional.
 *
 * Como o scaffold-runner: nunca toca o banco, nunca apaga diretório
 * meio-escrito (destrutivo no host) — só reporta caminho + erro.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { extractZipToDir } from '@mcp/design-system/extract-zip.js';
import { resolveTargetPath } from '../paths.js';
import { runHostCommand } from '../run-host-command.js';
import { NON_INTERACTIVE_ENV, INSTALL_TIMEOUT_MS } from '../templates/types.js';
import { findFreeBuilderPort } from '../builder-inject.js';
import type { DsStudioStack, WorkspaceFile } from './types.js';
import {
  buildReactWorkspaceFiles,
  injectDsStudioReactInstrumentation,
  REACT_APP_DEPS,
  REACT_APP_DEV_DEPS,
} from './react-inject.js';
import { buildVueWorkspaceFiles, VUE_APP_DEPS, VUE_APP_DEV_DEPS } from './templates-vue.js';
import { angularCliSteps, patchAngularWorkspace } from './templates-angular.js';

export interface DsStudioScaffoldInput {
  name: string;
  packageName: string;
  stack: DsStudioStack;
  /** Zip opcional extraído para `<workspace>/import/` (material bruto). */
  importZipPath?: string | null;
  isNameTaken?: (name: string) => boolean;
  /** Override do root de projetos (tests). */
  root?: string;
  signal?: AbortSignal;
  onPhase?: (d: { phase: string; label: string }) => void;
  onLog?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

export type DsStudioScaffoldOutcome =
  | { ok: true; targetPath: string; slug: string; name: string; port: number }
  | { ok: false; targetPath: string | null; error: { message: string; stderrTail?: string } };

function writeWorkspaceFiles(targetDir: string, files: WorkspaceFile[]): void {
  for (const f of files) {
    const abs = join(targetDir, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.contents, 'utf8');
  }
}

const IMPORT_README = [
  '# import/',
  '',
  'Raw reference material attached at creation (or via re-import).',
  'READ-ONLY for the DS agent: port components/ideas into `pkg/`,',
  'never edit these files and never import them at runtime.',
  '',
].join('\n');

export async function scaffoldDsStudioWorkspace(
  input: DsStudioScaffoldInput,
): Promise<DsStudioScaffoldOutcome> {
  const { onPhase, onLog, signal } = input;
  const fail = (
    targetPath: string | null,
    message: string,
    stderrTail?: string,
  ): DsStudioScaffoldOutcome => ({ ok: false, targetPath, error: { message, stderrTail } });

  let target;
  try {
    onPhase?.({ phase: 'resolve-path', label: 'Resolving workspace location' });
    target = resolveTargetPath(input.name, { root: input.root, isNameTaken: input.isNameTaken });
  } catch (err) {
    return fail(null, err instanceof Error ? err.message : String(err));
  }
  const targetDir = target.targetPath;

  const run = async (
    label: string,
    phase: string,
    program: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ ok: boolean; exitCode: number; stderrTail?: string }> => {
    onPhase?.({ phase, label });
    return runHostCommand({
      program,
      args,
      cwd: targetDir,
      env: NON_INTERACTIVE_ENV,
      timeoutMs,
      signal,
      onLog,
    });
  };

  try {
    const port = await findFreeBuilderPort();
    const tpl = { slug: target.slug, packageName: input.packageName };

    if (input.stack === 'react-ts') {
      onPhase?.({ phase: 'write-skeleton', label: 'Writing workspace skeleton' });
      mkdirSync(join(targetDir, 'pkg', 'src', 'components'), { recursive: true });
      writeWorkspaceFiles(targetDir, buildReactWorkspaceFiles(tpl));
      const dep = await run('Installing gallery dependencies…', 'install-deps', 'npm',
        ['install', '--workspace', 'app', '--no-audit', '--no-fund', '--loglevel=error', ...REACT_APP_DEPS],
        INSTALL_TIMEOUT_MS);
      if (!dep.ok) return fail(targetDir, `Dependency install failed (exit ${dep.exitCode})`, dep.stderrTail);
      const dev = await run('Installing dev dependencies…', 'install-dev-deps', 'npm',
        ['install', '--workspace', 'app', '--no-audit', '--no-fund', '--loglevel=error', '-D', ...REACT_APP_DEV_DEPS],
        INSTALL_TIMEOUT_MS);
      if (!dev.ok) return fail(targetDir, `Dev dependency install failed (exit ${dev.exitCode})`, dev.stderrTail);
      onPhase?.({ phase: 'configure', label: 'Instrumenting for element selection…' });
      injectDsStudioReactInstrumentation(join(targetDir, 'app'), port);
    } else if (input.stack === 'vue-ts') {
      onPhase?.({ phase: 'write-skeleton', label: 'Writing workspace skeleton' });
      mkdirSync(join(targetDir, 'pkg', 'src', 'components'), { recursive: true });
      writeWorkspaceFiles(targetDir, buildVueWorkspaceFiles(tpl, port));
      const dep = await run('Installing gallery dependencies…', 'install-deps', 'npm',
        ['install', '--workspace', 'app', '--no-audit', '--no-fund', '--loglevel=error', ...VUE_APP_DEPS],
        INSTALL_TIMEOUT_MS);
      if (!dep.ok) return fail(targetDir, `Dependency install failed (exit ${dep.exitCode})`, dep.stderrTail);
      const dev = await run('Installing dev dependencies…', 'install-dev-deps', 'npm',
        ['install', '--workspace', 'app', '--no-audit', '--no-fund', '--loglevel=error', '-D', ...VUE_APP_DEV_DEPS],
        INSTALL_TIMEOUT_MS);
      if (!dev.ok) return fail(targetDir, `Dev dependency install failed (exit ${dev.exitCode})`, dev.stderrTail);
    } else {
      // angular — CLI oficial dentro do targetDir pré-criado.
      mkdirSync(targetDir, { recursive: true });
      for (const step of angularCliSteps(target.slug)) {
        if (signal?.aborted) return fail(targetDir, 'Cancelled');
        const res = await run(step.label, step.phase, step.program, step.args, step.timeoutMs);
        if (!res.ok) return fail(targetDir, `${step.label} failed (exit ${res.exitCode})`, res.stderrTail);
      }
      onPhase?.({ phase: 'configure', label: 'Pinning dev port + package name…' });
      patchAngularWorkspace(targetDir, input.packageName, port);
    }

    if (input.importZipPath) {
      onPhase?.({ phase: 'import', label: 'Extracting reference material into import/…' });
      const stats = extractZipToDir(input.importZipPath, join(targetDir, 'import'), { clean: true });
      if (stats.filesWritten === 0) {
        return fail(targetDir, 'Import zip extracted to 0 files — empty or all entries unsafe.');
      }
      writeFileSync(join(targetDir, 'import', 'README.md'), IMPORT_README, 'utf8');
    }

    return { ok: true, targetPath: targetDir, slug: target.slug, name: target.name, port };
  } catch (err) {
    return fail(targetDir, err instanceof Error ? err.message : String(err));
  }
}
