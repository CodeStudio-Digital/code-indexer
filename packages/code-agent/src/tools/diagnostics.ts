import { spawnSync } from 'node:child_process';
import { extname, resolve, relative, isAbsolute } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';

/**
 * get_diagnostics — LSP-lite.
 *
 * Runs the project's native type/lint checker for a file and returns the
 * errors/warnings as structured text. This is the cheap "Phase 1" version
 * that shells out to `tsc --noEmit`, `ruff check`, `go vet`, etc. instead of
 * spawning a real language server. Good enough for 80% of the "did my edit
 * break anything?" check loop.
 *
 * Language → tool mapping:
 *   .ts/.tsx/.js/.jsx  → tsc --noEmit (project tsconfig)
 *   .py                → ruff check (if installed) else python -m py_compile
 *   .go                → go vet ./...
 *   .rs                → cargo check (slow — only on request)
 *
 * Results are cached in-memory by (abs path + mtime) so repeated calls in
 * the same session don't re-run the compiler.
 */

// Cache keyed by `${absPath}:${mtimeMs}`. Cleared per process.
const cache = new Map<string, string>();

type Language = 'ts' | 'py' | 'go' | 'rs' | 'unknown';

function detectLanguage(file: string): Language {
  const ext = extname(file).toLowerCase();
  if (['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'].includes(ext)) return 'ts';
  if (ext === '.py') return 'py';
  if (ext === '.go') return 'go';
  if (ext === '.rs') return 'rs';
  return 'unknown';
}

function resolveSafe(filePath: string, cwd: string): string | null {
  const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  const rel = relative(cwd, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return abs;
}

function runChecker(lang: Language, absPath: string, cwd: string): string {
  switch (lang) {
    case 'ts': {
      // Use the project's tsc via npx — respects local tsconfig.json.
      // --noEmit = type-check only, fastest mode.
      const r = spawnSync('npx', ['tsc', '--noEmit', '--pretty', 'false'], {
        cwd,
        encoding: 'utf-8',
        shell: true,
        timeout: 60_000,
      });
      const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
      if (!out) return 'OK: no type errors.';
      // Filter to lines mentioning this file — tsc --noEmit outputs errors
      // for the whole project, but the agent usually only cares about the
      // file it just edited.
      const relPath = relative(cwd, absPath).replace(/\\/g, '/');
      const filtered = out
        .split('\n')
        .filter((l) => l.toLowerCase().includes(relPath.toLowerCase()) || l.includes('error TS'))
        .join('\n');
      return filtered || `OK: no errors mentioning ${relPath} (project still has errors elsewhere).`;
    }
    case 'py': {
      // Prefer ruff if available — much faster and catches more.
      const ruff = spawnSync('ruff', ['check', absPath], { cwd, encoding: 'utf-8', timeout: 30_000 });
      if (!ruff.error) {
        const out = [ruff.stdout, ruff.stderr].filter(Boolean).join('\n').trim();
        return out || 'OK: no ruff findings.';
      }
      // Fallback: py_compile for syntax-only check
      const r = spawnSync('python', ['-m', 'py_compile', absPath], {
        cwd,
        encoding: 'utf-8',
        timeout: 30_000,
      });
      if (r.status === 0) return 'OK: syntax valid (py_compile).';
      return [r.stdout, r.stderr].filter(Boolean).join('\n').trim() || 'py_compile failed (no output)';
    }
    case 'go': {
      const r = spawnSync('go', ['vet', './...'], { cwd, encoding: 'utf-8', timeout: 60_000 });
      const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
      if (r.status === 0) return out || 'OK: go vet passed.';
      return out || 'go vet failed (no output)';
    }
    case 'rs': {
      const r = spawnSync('cargo', ['check', '--message-format=short'], {
        cwd,
        encoding: 'utf-8',
        timeout: 180_000,
      });
      const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
      if (r.status === 0) return out || 'OK: cargo check passed.';
      return out || 'cargo check failed (no output)';
    }
    case 'unknown':
      return 'No diagnostics checker configured for this file extension.';
  }
}

export const getDiagnostics: CoderTool = {
  name: 'get_diagnostics',
  description:
    'Run the language-native type/lint checker for a file and return errors/warnings.\n' +
    "USE: after editing a .ts/.tsx/.js/.py/.go/.rs file to catch type errors and obvious bugs BEFORE running tests. Much faster than full test suites.\n" +
    "USE: to verify a refactor didn't leave dangling references.\n" +
    "DON'T: use as a substitute for tests — this only catches type/syntax/lint issues, not behaviour.\n" +
    "DON'T: call before editing — the output reflects on-disk state, not your pending changes.\n" +
    "DON'T: loop on this tool to fix errors one-by-one. Read the full output, fix all related issues in one edit_file call, then re-run.\n" +
    'Result is cached by file mtime, so repeated calls in the same session are free.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Project-relative path of the file to check.',
      },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const fileArg = String(args.file_path ?? '').trim();
    if (!fileArg) return err('file_path cannot be empty');
    const abs = resolveSafe(fileArg, ctx.cwd);
    if (!abs) return err(`path '${fileArg}' escapes the project root — rejected`);
    if (!existsSync(abs)) return err(`file not found: ${fileArg}`);

    const lang = detectLanguage(abs);
    if (lang === 'unknown') {
      return ok(`No diagnostics checker configured for ${extname(abs)}. Supported: .ts/.tsx/.js/.jsx/.py/.go/.rs.`);
    }

    // Cache by mtime — repeated calls on an untouched file return instantly.
    const mtime = statSync(abs).mtimeMs;
    const key = `${abs}:${mtime}`;
    const hit = cache.get(key);
    if (hit !== undefined) return ok(hit + '\n[cached by mtime]');

    const out = runChecker(lang, abs, ctx.cwd);
    cache.set(key, out);
    // Bound cache size
    if (cache.size > 50) {
      const firstKey = cache.keys().next().value;
      if (firstKey) cache.delete(firstKey);
    }
    return ok(out);
  },
};

export const diagnosticsTools: CoderTool[] = [getDiagnostics];
