import { extname } from 'node:path';
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { pathFor, resolveWorkspacePath } from '@mcp/code-agent/tools/paths.js';
import { defaultLocalFilesystemPort, type IFilesystemPort } from '@mcp/code-agent/ports/filesystem-port.js';
import { defaultLocalShellPort, type ShellExecResult } from '@mcp/code-agent/ports/shell-port.js';
import { diagnosticLanguage, PYTHON_SYNTAX_CHECK } from './diagnostic-checkers.js';

async function localCompiler(root: string, fs: IFilesystemPort, signal?: AbortSignal): Promise<string | undefined> {
  // Walk ancestors for monorepos; never invoke npx or fetch a compiler.
  const path = pathFor(root);
  let directory = root;
  for (;;) {
    signal?.throwIfAborted();
    const candidate = path.join(directory, 'node_modules', 'typescript', 'bin', 'tsc');
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch (cause) {
      if (!['ENOENT', 'ENOTDIR'].includes((cause as NodeJS.ErrnoException).code ?? '')) throw cause;
    }
    const parent = path.dirname(directory); if (parent === directory) return; directory = parent;
  }
}

const missingExecutable = (message: string) => /\bENOENT\b/.test(message);

function render(result: ShellExecResult, label: string): ToolResult {
  const body = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  const content = result.timedOut ? `${label} timed out.\n${body}`
    : result.exitCode === null ? `${label} did not finish successfully.\n${body}`
    : result.exitCode !== 0 ? `${label} exited ${result.exitCode}.\n${body || '(no diagnostic output)'}`
    : body || `OK: ${label} passed.`;
  const truncated = [result.stdoutTruncation, result.stderrTruncation].filter(item => item != null);
  return { content, isError: result.timedOut || result.exitCode !== 0,
    ...(truncated.length ? { sourceTruncations: [{ technique: 'diagnostics-stream-bound', unit: 'bytes' as const,
      inputSize: truncated.reduce((sum, t) => sum + t.inputBytes, 0), outputSize: truncated.reduce((sum, t) => sum + t.outputBytes, 0),
      recoverable: false }] } : {}) };
}

export const getDiagnostics: CoderTool = {
  name: 'get_diagnostics',
  description:
    'Run the installed language checker for TS/JS, Python, Go, Rust or PHP. Reports exit status and bounded stdout/stderr. ' +
    'TS/JS, Go and Rust check the project, so errors may include other files. Python/PHP check the requested file. ' +
    'Use after related edits; dependencies and configuration are rechecked on every call. ' +
    'Compilers may run project build scripts or update build caches. Commands are cancellable, sequential, and owned by the attempt. ' +
    'TypeScript must already be installed in the project or a workspace ancestor; this tool does not install packages.',
  source: 'native', mutates: true, parallelSafe: false, riskLevel: 'execute',
  effectBoundary: 'shell', repeatPolicy: 'volatile',
  parameters: { type: 'object', properties: {
    file_path: { type: 'string', description: 'Project-relative file. Global sessions accept <project-slug>/path.' },
  }, required: ['file_path'], additionalProperties: false },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const file = String(args.file_path ?? '').trim();
    if (!file) return err('file_path cannot be empty');
    const resolved = resolveWorkspacePath(file, ctx, 'write');
    if (!resolved.ok || resolved.external) return err(resolved.ok ? `File is outside indexed project roots: ${file}` : resolved.reason);
    const fs = ctx.ports?.fs ?? defaultLocalFilesystemPort(), shell = ctx.ports?.shell ?? defaultLocalShellPort();
    try {
      ctx.signal?.throwIfAborted();
      if (!(await fs.stat(resolved.abs)).isFile()) return err(`Not a regular file: ${file}`);
      const lang = diagnosticLanguage(file);
      if (!lang) return ok(`No diagnostics checker configured for ${extname(file)}. Supported: TS/JS, Python, Go, Rust, PHP.`);
      const run = async (program: string, argv: string[], timeoutMs: number) => {
        ctx.signal?.throwIfAborted();
        const result = await shell.run(program, argv, { cwd: resolved.rootPath, signal: ctx.signal,
          runtimeEnv: ctx.runtimeEnv, timeoutMs, maxOutputBytes: 100_000 });
        ctx.signal?.throwIfAborted(); return result;
      };
      if (lang === 'ts') {
        const compiler = await localCompiler(resolved.rootPath, fs, ctx.signal);
        if (!compiler) return err('No project TypeScript compiler found. Install the project dependencies before requesting diagnostics.');
        return render(await run('node', [compiler, '--noEmit', '--pretty', 'false'], 60_000), 'TypeScript project check');
      }
      if (lang === 'py') {
        let result: ShellExecResult | undefined;
        try { result = await run('ruff', ['check', '--no-cache', '--', resolved.abs], 30_000); }
        catch (cause) { if (!missingExecutable(String(cause))) throw cause; }
        if (result && !(result.exitCode === null && missingExecutable(result.stderr))) return render(result, 'ruff check');
        ctx.signal?.throwIfAborted();
        return render(await run('python', ['-I', '-B', '-c', PYTHON_SYNTAX_CHECK, resolved.abs], 30_000), 'Python syntax check');
      }
      if (lang === 'go') return render(await run('go', ['vet', './...'], 60_000), 'go vet');
      if (lang === 'rs') return render(await run('cargo', ['check', '--message-format=short'], 180_000), 'cargo check');
      return render(await run('php', ['-l', resolved.abs], 30_000), 'php -l');
    } catch (cause) { return err(`Diagnostics failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
  },
};

export const diagnosticsTools: CoderTool[] = [getDiagnostics];
