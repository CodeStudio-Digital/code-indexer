/**
 * DS Studio — angular workspace via CLI oficial (não é template-izável à
 * mão com fidelidade). Estrutura gerada:
 *
 *   ng new <slug> --create-application=false  → workspace vazio
 *   ng generate application app               → projects/app (a galeria)
 *   ng generate library pkg                   → projects/pkg (a lib)
 *
 * Pós-CLI, `patchAngularWorkspace` pina a porta no script `dev` da raiz
 * (o dashboard sobe o preview com `npm run dev`) e renomeia o package da
 * lib para o nome npm escolhido. Publish: o prompt do agente instrui
 * `ng build pkg` antes de `ds_publish_version({ pkg_dir: 'dist/pkg' })`.
 * Sem stamp inline — seleção via universal inspector (CDP).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { INSTALL_TIMEOUT_MS } from '../templates/types.js';

export interface AngularCliStep {
  phase: string;
  label: string;
  program: string;
  args: string[];
  timeoutMs: number;
}

/** `ng new` instala node_modules — folga generosa sobre o install padrão. */
const NG_NEW_TIMEOUT_MS = Math.max(INSTALL_TIMEOUT_MS, 15 * 60_000);

export function angularCliSteps(slug: string): AngularCliStep[] {
  return [
    {
      phase: 'ng-new',
      label: 'Creating Angular workspace (ng new)…',
      program: 'npx',
      args: [
        '-y', '@angular/cli@latest', 'new', slug,
        '--directory', '.',
        '--create-application=false',
        '--skip-git',
        '--package-manager', 'npm',
        '--defaults',
      ],
      timeoutMs: NG_NEW_TIMEOUT_MS,
    },
    {
      phase: 'ng-app',
      label: 'Generating gallery application…',
      program: 'npx',
      args: ['ng', 'generate', 'application', 'app', '--routing=false', '--style=css', '--defaults'],
      timeoutMs: INSTALL_TIMEOUT_MS,
    },
    {
      phase: 'ng-lib',
      label: 'Generating library project…',
      program: 'npx',
      args: ['ng', 'generate', 'library', 'pkg', '--defaults'],
      timeoutMs: INSTALL_TIMEOUT_MS,
    },
  ];
}

/**
 * Pós-CLI: script dev com porta pinada, nome npm real na lib e docs seed.
 * Lança em caso de JSON ilegível — o chamador converte em erro de scaffold.
 */
export function patchAngularWorkspace(targetDir: string, packageName: string, port: number): void {
  const rootPkgPath = join(targetDir, 'package.json');
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  rootPkg.scripts = {
    ...rootPkg.scripts,
    // `host 0.0.0.0` não é necessário: o preview iframa http://localhost:<port>.
    dev: `ng serve app --port ${port}`,
  };
  writeFileSync(rootPkgPath, `${JSON.stringify(rootPkg, null, 2)}\n`, 'utf8');

  const libPkgPath = join(targetDir, 'projects', 'pkg', 'package.json');
  const libPkg = JSON.parse(readFileSync(libPkgPath, 'utf8')) as Record<string, unknown>;
  libPkg.name = packageName;
  writeFileSync(libPkgPath, `${JSON.stringify(libPkg, null, 2)}\n`, 'utf8');

  // docs.md vive na RAIZ da lib fonte; `ng build pkg` NÃO o copia para
  // dist/pkg — o prompt instrui o agente a mantê-lo em dist/pkg no publish
  // (ou copiá-lo). Seed aqui para o padrão existir desde o início.
  writeFileSync(
    join(targetDir, 'projects', 'pkg', 'docs.md'),
    `# ${packageName}\n\nAngular design system built with the DS Studio.\n`,
    'utf8',
  );
}
