import { describe, it, expect } from 'vitest';
import { shellTools } from '@mcp/code-agent/tools/shell.js';
import { LocalShellAdapter } from '@mcp/code-agent/ports/shell-port.js';
import type {
  IShellPort,
  ShellExecOptions,
  ShellExecResult,
  ShellRunOptions,
} from '@mcp/code-agent/ports/shell-port.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

const runCommand = shellTools.find((t) => t.name === 'run_command')!;

class CapturingShell implements IShellPort {
  lastExec: { command: string; options: ShellExecOptions } | undefined;
  result: ShellExecResult = { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false };

  async exec(command: string, options: ShellExecOptions): Promise<ShellExecResult> {
    this.lastExec = { command, options };
    return this.result;
  }
  async run(_p: string, _a: string[], _o: ShellRunOptions): Promise<ShellExecResult> {
    return this.result;
  }
  async spawn(_p: string, _a: string[], _o: ShellExecOptions): Promise<ShellExecResult> {
    return this.result;
  }
}

function makeContext(shell: IShellPort, cwd = process.cwd()): ToolContext {
  return {
    cwd,
    projectName: 'test',
    ports: { shell },
  };
}

describe('run_command stdin parameter', () => {
  it('forwards stdin to the shell port', async () => {
    const shell = new CapturingShell();
    const ctx = makeContext(shell);
    await runCommand.handler(
      { command: 'python -', stdin: "print('hi')" },
      ctx,
    );
    expect(shell.lastExec?.options.stdin).toBe("print('hi')");
  });

  it('omits stdin when not supplied', async () => {
    const shell = new CapturingShell();
    const ctx = makeContext(shell);
    await runCommand.handler({ command: 'echo hi' }, ctx);
    expect(shell.lastExec?.options.stdin).toBeUndefined();
  });

  it('rejects non-string stdin', async () => {
    const shell = new CapturingShell();
    const ctx = makeContext(shell);
    const r = await runCommand.handler(
      { command: 'python -', stdin: 123 as unknown as string },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/stdin must be a string/);
    expect(shell.lastExec).toBeUndefined();
  });

  it('rejects stdin larger than 100000 bytes', async () => {
    const shell = new CapturingShell();
    const ctx = makeContext(shell);
    const r = await runCommand.handler(
      { command: 'python -', stdin: 'x'.repeat(100_001) },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/stdin exceeds/);
    expect(shell.lastExec).toBeUndefined();
  });

  it('declares stdin in the JSON schema', () => {
    const params = runCommand.parameters as {
      properties: Record<string, { type: string }>;
    };
    expect(params.properties.stdin?.type).toBe('string');
  });
});

describe('LocalShellAdapter stdin', () => {
  it("delivers stdin to a process that reads it (via shell exec)", async () => {
    // Use `node -e` with an inline reader instead of `node -`. Two reasons:
    // 1. cmd.exe's handling of `node -` on Windows can swallow the stdin
    //    pipe before the child sees it; `node -e` doesn't depend on that.
    // 2. The point is to verify that `exec()` plumbs the `stdin` option
    //    through the shell wrapper to the child — which interpreter trick
    //    we use to read it is incidental.
    const adapter = new LocalShellAdapter();
    const reader =
      "let d='';process.stdin.on('data',c=>d+=c);" +
      "process.stdin.on('end',()=>process.stdout.write('got:'+d))";
    // Quote the script differently per platform: cmd needs double quotes
    // around -e arg, bash needs single quotes to avoid $-expansion. Use
    // node's `-e` with double-quoted body and escape the inner double
    // quotes — works in both /bin/bash -c and cmd /d /s /c.
    const escaped = reader.replace(/"/g, '\\"');
    const r = await adapter.exec(`node -e "${escaped}"`, {
      cwd: process.cwd(),
      timeoutMs: 30_000,
      stdin: 'hello',
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('got:hello');
  });

  it("passes stdin through `spawn` (no shell parsing)", async () => {
    const adapter = new LocalShellAdapter();
    const r = await adapter.spawn(
      'node',
      [
        '-e',
        "let d='';process.stdin.on('data',c=>d+=c);" +
          "process.stdin.on('end',()=>process.stdout.write('len:'+d.length))",
      ],
      { cwd: process.cwd(), timeoutMs: 30_000, stdin: 'abcde' },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('len:5');
  });

  it("does not hang when the process ignores stdin (EPIPE swallowed)", async () => {
    const adapter = new LocalShellAdapter();
    // node -e with no read of process.stdin — child exits immediately,
    // our writeStdin sees EPIPE on the pipe and ignores it.
    const r = await adapter.exec('node -e "process.stdout.write(\'done\')"', {
      cwd: process.cwd(),
      timeoutMs: 10_000,
      stdin: 'ignored payload',
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('done');
  });
});
