import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { killProcessTree } from '@mcp/shared/utils/process-tree.js';
import { LocalShellAdapter } from '../shell-port.js';
import { shellTools } from '../../tools/shell.js';

it.skipIf(process.platform !== 'win32')('returns a Windows background launcher receipt without waiting for or killing its server', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'shell-background-exit-'));
  const token = `owned-${Date.now()}`;
  writeFileSync(join(cwd, 'server.cjs'), `require('node:fs').writeFileSync('owned.json',JSON.stringify({pid:process.pid,token:${JSON.stringify(token)}}));setTimeout(()=>process.exit(0),15000);`);
  let ownedPid: number | undefined;
  let launcherPid: number | undefined;
  try {
    const command = `powershell -NoProfile -Command "$p = Start-Process -WindowStyle Hidden -FilePath $env:ComSpec -ArgumentList '/d /s /c node server.cjs' -WorkingDirectory $PWD.Path -RedirectStandardOutput (Join-Path $PWD 'stdout.log') -RedirectStandardError (Join-Path $PWD 'stderr.log') -PassThru; [pscustomobject]@{ProcessId=$p.Id} | ConvertTo-Json -Compress"`;
    const started = performance.now();
    const result = await new LocalShellAdapter().exec(command, { cwd, timeoutMs: 4000 });
    expect(performance.now() - started).toBeLessThan(4000);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, outputDrainTimedOut: true });
    launcherPid = JSON.parse(result.stdout).ProcessId;
    expect(launcherPid).toBeGreaterThan(0);
    await expect.poll(() => existsSync(join(cwd, 'owned.json'))).toBe(true);
    const receipt = JSON.parse(readFileSync(join(cwd, 'owned.json'), 'utf8'));
    expect(receipt.token).toBe(token); ownedPid = receipt.pid;
    expect(() => process.kill(ownedPid!, 0)).not.toThrow();
  } finally {
    // Only the fresh fixture's PID receipt may authorize cleanup.
    if (!ownedPid && existsSync(join(cwd, 'owned.json'))) {
      const receipt = JSON.parse(readFileSync(join(cwd, 'owned.json'), 'utf8'));
      if (receipt.token === token) ownedPid = receipt.pid;
    }
    if (launcherPid) {
      await killProcessTree(launcherPid);
      await expect.poll(() => { try { process.kill(launcherPid!, 0); return true; } catch { return false; } }, { timeout: 5000 }).toBe(false);
    }
    if (ownedPid) {
      try { process.kill(ownedPid, 0); await killProcessTree(ownedPid); } catch { /* launcher tree already reaped it */ }
      await expect.poll(() => { try { process.kill(ownedPid!, 0); return true; } catch { return false; } }, { timeout: 5000 }).toBe(false);
    }
    // Windows may release the redirected log handles just after process exit.
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 20000);

it('reports unconfirmed shell cleanup as uncertain with the command PID and recovery guidance', async () => {
  const tool = shellTools.find(t => t.name === 'run_command')!;
  const result = await tool.handler({ command: 'fixture', timeout_ms: 1000 }, {
    cwd: process.cwd(), projectName: 'fixture', ports: { shell: {
      exec: async () => ({ stdout: 'partial', stderr: '', exitCode: null, timedOut: true,
        processId: 123, terminationUnconfirmed: true }),
    } as never },
  });
  expect(result).toMatchObject({ isError: true, effectOutcome: 'unknown' });
  expect(result.content).toContain('command PID: 123');
  expect(result.content).toContain('exit code: unconfirmed');
  expect(result.content).toContain('write_stdin');
});
