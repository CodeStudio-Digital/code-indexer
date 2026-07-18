/**
 * run_command — 536 historical calls (25,9% erro na telemetria), zero tests.
 * Locks in: output format ($ cmd / exit code / stdout-stderr blocks), the
 * non-zero-exit→isError contract, cwd containment, stdin feeding, and the
 * plan-mode read-only gate (composition metachars blocked, read heads pass).
 *
 * Cross-platform: only `echo`, `exit` and `node` are used — all valid under
 * cmd.exe (Windows) and bash/sh (POSIX), matching the LocalShellAdapter.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { IShellPort } from '@mcp/code-agent/ports/shell-port.js';
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

  it('defensively preserves the true tail from an oversized remote shell adapter', async () => {
    const output = `REMOTE-BEGIN-${'x'.repeat(120_000)}-REMOTE-TRUE-END \t\n\n`;
    const shell = {
      exec: async () => ({ stdout: output, stderr: '', exitCode: 0, timedOut: false }),
    } as unknown as IShellPort;
    const remoteCtx = { ...ctx, ports: { shell } } as ToolContext;

    const res = await runCommand.handler({ command: 'remote-command' }, remoteCtx);

    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('REMOTE-BEGIN-');
    expect(res.content).toContain('-REMOTE-TRUE-END');
    expect(res.content).toMatch(/\[truncated: \d+ bytes omitted;/);
    expect(res.content.endsWith('-REMOTE-TRUE-END \t\n\n')).toBe(true);
    expect(res.sourceTruncations).toEqual([
      expect.objectContaining({
        technique: 'bounded-stream-cap:stdout',
        unit: 'bytes',
        recoverable: false,
      }),
    ]);
    expect(res.sourceTruncations![0]!.inputSize).toBeGreaterThan(
      res.sourceTruncations![0]!.outputSize,
    );
  });

  it('stores the exact pre-guard result when an oversized remote adapter materialized it fully', async () => {
    const output = `REMOTE-BEGIN-${'x'.repeat(120_000)}-REMOTE-TRUE-END`;
    const shell = {
      exec: async () => ({ stdout: output, stderr: 'remote-stderr', exitCode: 0, timedOut: false }),
    } as unknown as IShellPort;
    const put = vi.fn(() => 'abc123def456');
    const remoteCtx = {
      ...ctx,
      ports: { shell },
      toolOutputStore: { put },
    } as unknown as ToolContext;

    const res = await runCommand.handler({ command: 'remote-command' }, remoteCtx);

    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(
      `$ remote-command\nexit code: 0\n--- stdout ---\n${output}\n--- stderr ---\nremote-stderr`,
    );
    expect(res.sourceTruncations).toEqual([
      expect.objectContaining({
        technique: 'bounded-stream-cap:stdout',
        recoverable: true,
        outputId: 'abc123def456',
      }),
    ]);
  });

  it('does not discard whitespace-only streams or their truncation metadata', async () => {
    const shell = {
      exec: async () => ({ stdout: ' '.repeat(120_000), stderr: '\n'.repeat(120_000), exitCode: 0, timedOut: false }),
    } as unknown as IShellPort;
    const remoteCtx = { ...ctx, ports: { shell } } as ToolContext;

    const res = await runCommand.handler({ command: 'remote-whitespace' }, remoteCtx);

    expect(res.content).toContain('--- stdout ---');
    expect(res.content).toContain('--- stderr ---');
    expect(res.sourceTruncations?.map((item) => item.technique)).toEqual([
      'bounded-stream-cap:stdout',
      'bounded-stream-cap:stderr',
    ]);
  });

  it('composes adapter truncation with the local oversized-materialization guard', async () => {
    const put = vi.fn(() => 'must-not-be-used');
    const shell = {
      exec: async () => ({
        stdout: `ADAPTER-BEGIN-${'x'.repeat(150_000)}-ADAPTER-END`,
        stderr: '',
        exitCode: 0,
        timedOut: false,
        stdoutTruncation: { inputBytes: 250_000, outputBytes: 150_026 },
      }),
    } as unknown as IShellPort;
    const remoteCtx = {
      ...ctx,
      ports: { shell },
      toolOutputStore: { put },
    } as unknown as ToolContext;

    const res = await runCommand.handler({ command: 'remote-double-bound' }, remoteCtx);

    expect(res.content).toContain('ADAPTER-BEGIN-');
    expect(res.content).toContain('-ADAPTER-END');
    expect(res.sourceTruncations?.map((item) => item.technique)).toEqual([
      'bounded-stream-cap:stdout',
      'bounded-stream-cap:stdout:local-guard',
    ]);
    expect(res.sourceTruncations?.[1]).toEqual(expect.objectContaining({
      inputSize: 150_026,
      outputSize: 100_000,
      recoverable: false,
    }));
    expect(res.sourceTruncations?.some((item) => item.outputId)).toBe(false);
    expect(put).not.toHaveBeenCalled();
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
