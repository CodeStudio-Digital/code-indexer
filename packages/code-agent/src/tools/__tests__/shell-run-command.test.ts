/**
 * run_command — 536 historical calls (25,9% erro na telemetria), zero tests.
 * Locks in: output format ($ cmd / exit code / stdout-stderr blocks), the
 * non-zero-exit→isError contract, cwd containment, stdin feeding, and the
 * plan-mode read-only gate (composition metachars blocked, read heads pass).
 *
 * Cross-platform: only `echo`, `exit` and `node` are used — all valid under
 * cmd.exe (Windows) and bash/sh (POSIX), matching the LocalShellAdapter.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { shellTools } from '../shell.js';

const runCommand = shellTools.find((t) => t.name === 'run_command')!;

let root: string;
let ctx: ToolContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shell-run-'));
  ctx = { cwd: root, projectName: 'shell-run-test' } as ToolContext;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('run_command — outcomes and format', () => {
  it('a succeeding command returns ok with the $ header and stdout block', async () => {
    const res = await runCommand.handler({ command: 'echo hello-tools' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('$ echo hello-tools');
    expect(res.content).toContain('exit code: 0');
    expect(res.content).toContain('--- stdout ---');
    expect(res.content).toContain('hello-tools');
  });

  it('a non-zero exit is an error that still carries the full output', async () => {
    const res = await runCommand.handler({ command: 'exit 3' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('exit code: 3');
  });

  it('empty command is rejected before spawning anything', async () => {
    const res = await runCommand.handler({ command: '   ' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toBe('command cannot be empty');
  });

  it('feeds stdin to interpreters (the cross-shell quoting escape hatch)', async () => {
    const res = await runCommand.handler(
      { command: 'node -', stdin: 'console.log("from-stdin:" + (40 + 2))' },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('from-stdin:42');
  });
});

describe('run_command — cwd containment', () => {
  it('accepts a subdirectory inside the root', async () => {
    mkdirSync(join(root, 'sub'));
    const res = await runCommand.handler({ command: 'echo ok', cwd: 'sub' }, ctx);
    expect(res.isError).toBeFalsy();
  });

  it('refuses a cwd outside the project root', async () => {
    const res = await runCommand.handler({ command: 'echo ok', cwd: '..' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("cwd '..' is outside project root");
  });
});

describe('run_command — plan-mode read-only gate', () => {
  const planCtx = (): ToolContext =>
    ({
      ...ctx,
      runner: {
        isPlanMode: () => true,
        isPlanApproved: () => false,
      } as unknown as ToolContext['runner'],
    }) as ToolContext;

  it('allows a read-only head (echo) while a plan is pending', async () => {
    const res = await runCommand.handler({ command: 'echo exploring' }, planCtx());
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('exploring');
  });

  it('blocks shell composition (pipe) with the submit_plan pointer', async () => {
    const res = await runCommand.handler({ command: 'echo x | sort' }, planCtx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain('Command blocked in plan mode');
    expect(res.content).toContain('submit_plan');
  });

  it('blocks a non-allowlisted head (node can do anything)', async () => {
    const res = await runCommand.handler({ command: 'node evil.js' }, planCtx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("'node' is not in the read-only command allowlist");
  });

  it('the gate lifts once the plan is approved', async () => {
    const approved = {
      ...ctx,
      runner: {
        isPlanMode: () => true,
        isPlanApproved: () => true,
      } as unknown as ToolContext['runner'],
    } as ToolContext;
    const res = await runCommand.handler({ command: 'echo x | sort' }, approved);
    expect(res.isError).toBeFalsy();
  });
});
