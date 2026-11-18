/**
 * Detect the project's REAL verify commands (test / typecheck / lint / build)
 * so the system prompt can hand them to the agent instead of letting it guess
 * `npm test` on a pnpm/cargo/pytest project.
 *
 * Rendered BELOW `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` (sibling of the repo map):
 * package.json contents vary per project and over time, so this must never
 * touch the shared static prefix. Best-effort and synchronous — any read or
 * parse failure returns '' and the prompt simply omits the block.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Script names worth surfacing, in display order. */
const PREFERRED = ['test', 'typecheck', 'check', 'lint', 'build', 'verify'];
const MAX_SCRIPTS = 10;

export function detectVerifyCommands(projectRoot: string, platform = process.platform): string {
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    const hasMakefile = fs.existsSync(path.join(projectRoot, 'Makefile'));
    const hasJustfile = fs.existsSync(path.join(projectRoot, 'justfile'));
    if (!fs.existsSync(pkgPath)) {
      if (!hasMakefile && !hasJustfile) return '';
      const runner = hasMakefile ? 'Makefile (`make <target>`)' : 'justfile (`just <recipe>`)';
      return `# Known verify commands (detected)\nNo package.json; this project uses a ${runner}. Read it once to learn the real targets before running builds/tests.`;
    }

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      scripts?: Record<string, string>;
      packageManager?: string;
    };
    const names = Object.keys(pkg.scripts ?? {});
    if (names.length === 0 && !hasMakefile && !hasJustfile) return '';

    // Preferred verify-ish scripts first (including namespaced variants like
    // `test:unit` / `check:types`), then the rest, capped.
    const preferred = names.filter((n) => PREFERRED.some((p) => n === p || n.startsWith(`${p}:`)));
    const rest = names.filter((n) => !preferred.includes(n));
    const shown = [...preferred, ...rest].slice(0, MAX_SCRIPTS);

    const manager = pkg.packageManager?.split('@')[0]
      ?? (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml')) ? 'pnpm'
        : fs.existsSync(path.join(projectRoot, 'yarn.lock')) ? 'yarn'
        : fs.existsSync(path.join(projectRoot, 'bun.lockb')) ? 'bun'
        : 'npm');

    const lines = [`# Known verify commands (detected)`];
    if (shown.length > 0) {
      lines.push(
        `package.json scripts: ${shown.join(', ')} — run via \`${manager} run <script>\`.`,
      );
    }
    if (hasMakefile) lines.push('A Makefile exists — `make <target>` may cover build/test too.');
    if (hasJustfile) lines.push('A justfile exists — `just <recipe>` may cover build/test too.');
    const extension = platform === 'win32' ? '.cmd' : '';
    const localBins = ['tsc', 'ava', 'vitest', 'jest', 'eslint', 'xo', 'biome', 'ruff'].map(name => `node_modules/.bin/${name}${extension}`)
      .filter(file => fs.existsSync(path.join(projectRoot, file)));
    if (localBins.length) lines.push(`Installed verification entrypoints (observed): ${localBins.map(file => `\`${file}\``).join(', ')}. Use the declared script or these entrypoints with scoped arguments; do not guess a package's internal cli.js path.`);
    lines.push('Prefer these over guessed commands.');
    return lines.join('\n');
  } catch {
    return '';
  }
}
