/**
 * Single source of truth for path → language id (Monaco-compatible ids).
 *
 * Used by BOTH sides of the LSP plumbing: the renderer (Monaco model
 * language + provider routing) and the backend (document store + per-
 * language backend dispatch). Extracted from MonacoMount's inferLanguage —
 * keep ids aligned with Monaco's registry, since they double as Monaco
 * `language` props.
 */
const JSON_CONVENTION_FILES = new Set([
  '.babelrc',
  '.bowerrc',
  '.eslintrc',
  '.hintrc',
  '.jshintrc',
  '.prettierrc',
  '.stylelintrc',
  '.swcrc',
  'composer.lock',
  'deno.lock',
  'flake.lock',
  'package-lock.json',
  'package.json',
]);

const INI_CONVENTION_FILES = new Set([
  '.browserslistrc',
  '.editorconfig',
  '.gitconfig',
  '.gitmodules',
  '.npmrc',
  '.pnpmrc',
  '.yarnrc',
]);

/** Gitignore-compatible files, including tool-specific `.somethingignore`s. */
export function isIgnoreFilePath(filePath: string): boolean {
  const normalized = filePath.toLowerCase().replace(/\\/g, '/');
  const base = normalized.split('/').pop() ?? '';
  if (normalized.endsWith('/.git/info/exclude')) return true;
  if (base === '.git-blame-ignore-revs' || base === '.gitignore-global' || base === '.gitignore_global') return true;
  if (base === 'gitignore' || base === 'dockerignore' || base === 'ignore') return true;
  return base === '.ignore'
    || base.endsWith('.ignore')
    || (base.startsWith('.') && base.endsWith('ignore'));
}

export function languageIdForPath(path: string): string {
  const normalized = path.toLowerCase().replace(/\\/g, '/');
  const base = normalized.split('/').pop() ?? '';
  // Extensionless launchers and convention-based build files need an explicit
  // mapping: Monaco cannot infer a language from their contents or shebang.
  if (isIgnoreFilePath(normalized) || base === '.gitattributes') return 'ignore';
  if (JSON_CONVENTION_FILES.has(base)) return 'json';
  if (INI_CONVENTION_FILES.has(base)) return 'ini';
  if (base === 'codeowners') return 'codeowners';
  if (base === '.env' || base.startsWith('.env.')) return 'dotenv';
  if (base === 'dockerfile' || base.startsWith('dockerfile.')
    || base === 'containerfile' || base.startsWith('containerfile.')) return 'dockerfile';
  if (base === 'gradlew' || base === 'mvnw' || base === 'configure'
    || base === '.bashrc' || base === '.bash_profile' || base === '.profile'
    || base === '.zshrc' || base === '.zprofile') return 'shell';
  if (base === 'jenkinsfile' || base.endsWith('.gradle')) return 'groovy';
  if (base === 'gemfile' || base === 'rakefile' || base === 'vagrantfile') return 'ruby';
  // TextMate-backed ids (lib/textmate/bridge.ts) — convention files first.
  if (base === 'makefile' || base === 'gnumakefile') return 'makefile';
  if (base === 'cmakelists.txt') return 'cmake';
  if (base === 'cargo.lock') return 'toml';
  const ext = base.includes('.') ? base.split('.').pop() ?? '' : '';
  switch (ext) {
    case 'ts': case 'cts': case 'mts': return 'typescript';
    case 'tsx': return 'typescript';
    case 'js': case 'cjs': case 'mjs': return 'javascript';
    case 'jsx': return 'javascript';
    case 'json': case 'jsonc': case 'jsonb': case 'geojson': case 'topojson':
    case 'har': case 'ipynb': case 'webmanifest': case 'code-workspace': return 'json';
    case 'jsonl': case 'ndjson': case 'jsonlines': case 'ldjson': return 'jsonl';
    case 'json5': return 'json5';
    case 'hjson': return 'hjson';
    case 'jsonnet': case 'libsonnet': return 'jsonnet';
    case 'md': case 'markdown': return 'markdown';
    case 'css': return 'css';
    case 'scss': return 'scss';
    case 'less': return 'less';
    case 'html': case 'htm': return 'html';
    case 'vue': return 'vue';
    case 'svelte': return 'svelte';
    case 'xml': case 'csproj': case 'fsproj': case 'vbproj':
    case 'props': case 'targets': case 'nuspec': case 'resx': case 'xaml': return 'xml';
    case 'yaml': case 'yml': return 'yaml';
    case 'toml': return 'toml';
    case 'ini': case 'cfg': case 'conf': case 'properties': return 'ini';
    case 'env': return 'dotenv';
    case 'csv': return 'csv';
    case 'tsv': return 'tsv';
    case 'log': return 'log';
    case 'py': return 'python';
    case 'rb': return 'ruby';
    case 'php': return 'php';
    case 'go': return 'go';
    case 'rs': return 'rust';
    case 'java': return 'java';
    case 'kt': case 'kts': return 'kotlin';
    case 'swift': return 'swift';
    case 'cs': return 'csharp';
    case 'cpp': case 'cc': case 'cxx': case 'hpp': return 'cpp';
    case 'c': case 'h': return 'c';
    case 'lua': return 'lua';
    case 'dart': return 'dart';
    case 'scala': return 'scala';
    case 'sql': return 'sql';
    case 'sh': case 'bash': case 'zsh': case 'fish': return 'shell';
    case 'bat': case 'cmd': return 'bat';
    case 'ps1': return 'powershell';
    case 'dockerfile': case 'containerfile': return 'dockerfile';
    // TextMate-backed ids (lib/textmate/bridge.ts).
    case 'mk': case 'mak': return 'makefile';
    case 'cmake': return 'cmake';
    case 'diff': case 'patch': return 'diff';
    case 'zig': return 'zig';
    case 'prisma': return 'prisma';
    case 'nix': return 'nix';
    case 'hs': return 'haskell';
    default: return 'plaintext';
  }
}

/** Content-aware fallback for extensionless executable scripts. */
export function languageIdForDocument(path: string, content?: string | null): string {
  const pathLanguage = languageIdForPath(path);
  if (pathLanguage !== 'plaintext' || !content?.startsWith('#!')) return pathLanguage;
  const shebang = content.slice(0, content.indexOf('\n') === -1 ? content.length : content.indexOf('\n')).toLowerCase();
  if (/\b(?:ba|da|k|z)?sh\b/.test(shebang)) return 'shell';
  if (/\b(?:python|python\d+(?:\.\d+)?)\b/.test(shebang)) return 'python';
  if (/\b(?:node|deno|bun)\b/.test(shebang)) return 'javascript';
  if (/\bruby\b/.test(shebang)) return 'ruby';
  if (/\bphp\b/.test(shebang)) return 'php';
  if (/\b(?:pwsh|powershell)\b/.test(shebang)) return 'powershell';
  return pathLanguage;
}
