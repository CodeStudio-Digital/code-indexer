import { describe, it, expect } from 'vitest';
import type {
  IShellPort,
  ShellExecResult,
} from '@mcp/code-agent/ports/shell-port.js';
import { checkPodman, checkPodmanMachine } from '../checks-podman.js';
import { checkGit } from '../checks-platform.js';
import { runPreflight } from '../run-preflight.js';
import { listMachines, runMachineSetup, type MachineProgress } from '../../podman-machine/machine-actions.js';

type RunHandler = (program: string, args: string[]) => Partial<ShellExecResult> | undefined;

function mockShell(handler: RunHandler): IShellPort {
  return {
    async run(program: string, args: string[]): Promise<ShellExecResult> {
      const r = handler(program, args) ?? { exitCode: 127, stderr: 'ENOENT' };
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0, timedOut: false };
    },
    async exec(): Promise<ShellExecResult> {
      throw new Error('exec not used in preflight');
    },
    async spawn(): Promise<ShellExecResult> {
      throw new Error('spawn not used in preflight');
    },
  };
}

const PODMAN_PRESENT: RunHandler = (p, a) => {
  if (p === 'podman' && a[0] === 'version') return { exitCode: 0, stdout: '5.1.2\n' };
  if (p === 'git') return { exitCode: 0, stdout: 'git version 2.45.0\n' };
  return { exitCode: 0, stdout: '' };
};

describe('checkPodman', () => {
  it('reports ok + blocking when podman answers', async () => {
    const r = await checkPodman(mockShell(PODMAN_PRESENT));
    expect(r.status).toBe('ok');
    expect(r.blocking).toBe(true);
    expect(r.detail?.version).toBe('5.1.2');
  });

  it('reports missing + blocking when podman is absent', async () => {
    const r = await checkPodman(mockShell(() => ({ exitCode: 127, stderr: 'not found' })));
    expect(r.status).toBe('missing');
    expect(r.blocking).toBe(true);
    expect(r.remediation).toBe('install-podman');
  });
});

describe('checkPodmanMachine', () => {
  it('is a no-op ok on Linux (never touches the shell)', async () => {
    const r = await checkPodmanMachine(
      mockShell(() => {
        throw new Error('shell must not be called on linux');
      }),
      'linux',
      true,
    );
    expect(r.status).toBe('ok');
  });

  it('is missing when no machine exists (win32)', async () => {
    const r = await checkPodmanMachine(mockShell(() => ({ exitCode: 0, stdout: '[]' })), 'win32', true);
    expect(r.status).toBe('missing');
    expect(r.remediation).toBe('init-machine');
  });

  it('warns when a machine exists but is stopped (win32)', async () => {
    const json = JSON.stringify([{ Name: 'podman-machine-default', Running: false }]);
    const r = await checkPodmanMachine(mockShell(() => ({ exitCode: 0, stdout: json })), 'win32', true);
    expect(r.status).toBe('warn');
    expect(r.remediation).toBe('start-machine');
    expect(r.detail?.name).toBe('podman-machine-default');
  });

  it('is ok when a machine is running (win32)', async () => {
    const json = JSON.stringify([{ Name: 'pm', Running: true }]);
    const r = await checkPodmanMachine(mockShell(() => ({ exitCode: 0, stdout: json })), 'win32', true);
    expect(r.status).toBe('ok');
  });
});

describe('listMachines', () => {
  it('parses JSON output', async () => {
    const json = JSON.stringify([{ Name: 'a', Running: true }, { Name: 'b', Running: false }]);
    const m = await listMachines(mockShell(() => ({ exitCode: 0, stdout: json })));
    expect(m).toHaveLength(2);
  });

  it('falls back to plain-text parsing', async () => {
    const text = 'NAME  VM  RUNNING\npodman-machine-default*  qemu  Currently running\n';
    const m = await listMachines(mockShell(() => ({ exitCode: 0, stdout: text })));
    expect(m).toHaveLength(1);
    expect(m[0]?.Name).toBe('podman-machine-default');
    expect(m[0]?.Running).toBe(true);
  });

  it('returns [] on empty output', async () => {
    const m = await listMachines(mockShell(() => ({ exitCode: 0, stdout: '' })));
    expect(m).toEqual([]);
  });
});

describe('checkGit', () => {
  it('ok when git answers', async () => {
    const r = await checkGit(mockShell((p) => (p === 'git' ? { exitCode: 0, stdout: 'git version 2.45.0' } : undefined)));
    expect(r.status).toBe('ok');
  });
  it('warns (non-blocking) when git is absent', async () => {
    const r = await checkGit(mockShell(() => ({ exitCode: 127 })));
    expect(r.status).toBe('warn');
    expect(r.blocking).toBe(false);
  });
});

describe('runMachineSetup', () => {
  it('is a no-op on Linux — emits skip + done, never spawns', async () => {
    const events: MachineProgress[] = [];
    await runMachineSetup((e) => events.push(e), {
      platform: 'linux',
      shell: mockShell(() => {
        throw new Error('no shell on linux');
      }),
    });
    expect(events.map((e) => e.kind)).toEqual(['phase', 'done']);
    expect(events[0]).toMatchObject({ kind: 'phase', phase: 'skip' });
  });
});

describe('runPreflight', () => {
  it('checks Git and disk without probing container dependencies', async () => {
    const shell = mockShell((program) => {
      expect(program).toBe('git');
      return { exitCode: 127, stderr: 'git not found' };
    });
    const report = await runPreflight({ dbPath: process.cwd() + '/index.db', shell });
    expect(report.checks.map(check => check.id)).toEqual(['git', 'disk']);
    expect(report.blocked).toBe(false);
  });
});
