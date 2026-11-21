/**
 * get_diagnostics runs a checker; that is never an edit. When the checker it
 * ran is one the ledger recognizes from a shell command, the call carries the
 * exact validation signal that the same command run through the shell would
 * (same extractor, so the labels cannot drift). The Python syntax fallback has
 * no shell-recognized equivalent and yields no signal, as in the shell.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolCallLedger, extractValidationSignal } from '../tool-call-ledger.js';
import { ToolRegistry } from '../registry.js';
import type { CoderTool, ToolContext } from '../tool.js';
import type { IShellPort } from '../../ports/shell-port.js';
import { getDiagnostics } from '../../tools/diagnostics.js';
import { evaluateVerificationReadiness } from '../runner/nodes/executing-verification-gate.js';
import { makeTestContext } from '../runner/nodes/__tests__/test-helpers.js';

const CHECKS: Array<[string, string | undefined]> = [
  ['tsc --noEmit --pretty false', 'tsc --noEmit'],
  ['ruff check --no-cache', 'static validation'],
  ['go vet ./...', 'go validation'],
  ['cargo check --message-format=short', 'cargo validation'],
  ['php -l', 'php -l'],
  ['python -I -B -c', undefined],
];

function recordDiagnostics(ledger: ToolCallLedger, command: string | undefined, exitCode: number | null) {
  return ledger.record({
    name: 'get_diagnostics', args: { file_path: 'src/a.ts' }, content: exitCode === 0 ? 'OK' : 'errors',
    isError: exitCode !== 0, mutates: true, executionClass: 'execute', repeatPolicy: 'volatile',
    ...(command ? { structuredData: { kind: 'diagnostics_result', command, exitCode } } : {}),
  });
}

describe('get_diagnostics validation signal', () => {
  it.each(CHECKS)('%s carries the shell signal %s', (command, label) => {
    expect(extractValidationSignal('run_command', { command })).toBe(label);
    const passed = recordDiagnostics(new ToolCallLedger(), command, 0);
    expect(passed?.validationSignal).toBe(label);
    if (label) expect(passed?.validationOutcome).toBe('passed');
    const failed = recordDiagnostics(new ToolCallLedger(), command, 2);
    if (label) expect(failed?.validationOutcome).toBe('failed');
  });

  it('only a diagnostics result can carry it', () => {
    const ledger = new ToolCallLedger();
    const other = ledger.record({ name: 'read_file', args: { path: 'a' }, content: 'x', isError: false,
      structuredData: { kind: 'diagnostics_result', command: 'tsc --noEmit', exitCode: 0 } });
    expect(other?.validationSignal).toBeUndefined();
  });

  it('the handler reports the checker command it ran, without paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'diag-signal-'));
    try {
      await writeFile(join(root, 'a.php'), '<?php echo 1;');
      const shell = { mutationFenceAttested: true,
        run: async () => ({ stdout: 'No syntax errors', stderr: '', exitCode: 0, timedOut: false }) } as unknown as IShellPort;
      const res = await getDiagnostics.handler({ file_path: 'a.php' }, { cwd: root, projectName: 'd', ports: { shell } } as ToolContext);
      expect(res.structuredData).toEqual({ kind: 'diagnostics_result', command: 'php -l', exitCode: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('verification gate', () => {
  function harness() {
    const ledger = new ToolCallLedger();
    const registry = new ToolRegistry();
    for (const tool of [getDiagnostics, { ...getDiagnostics, name: 'edit_file' } as CoderTool]) registry.register(tool);
    const { ctx } = makeTestContext({ registry,
      toolContext: { cwd: process.cwd(), projectName: 'diag-gate', toolCallLedger: ledger } as ToolContext });
    const edit = () => ledger.record({ name: 'edit_file', args: { path: 'src/a.ts' }, content: 'edited', isError: false,
      mutates: true, executionClass: 'write' });
    return { ctx, ledger, edit };
  }

  it('a passing diagnostics run after the edit certifies it, like the shell check', () => {
    const { ctx, ledger, edit } = harness();
    edit();
    recordDiagnostics(ledger, 'tsc --noEmit --pretty false', 0);
    expect(evaluateVerificationReadiness(ctx).status).toBe('fresh');
  });

  it('a diagnostics call without a recognized checker is not a later write', () => {
    const { ctx, ledger, edit } = harness();
    edit();
    ledger.record({ name: 'run_command', args: { command: 'pnpm test' }, content: 'exit code 0', isError: false,
      executionClass: 'execute' });
    recordDiagnostics(ledger, undefined, 0); // e.g. "No diagnostics checker configured for .md"
    recordDiagnostics(ledger, 'python -I -B -c', 0);
    expect(evaluateVerificationReadiness(ctx).status).toBe('fresh');
  });
});
