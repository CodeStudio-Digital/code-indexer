import { describe, it, expect } from 'vitest';
import { resolve as resolvePath, join, sep } from 'node:path';
import { resolveHostPath } from '@mcp/company/tools/design-system/ds-publish-version.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { CompanyContext, SandboxBinding } from '@mcp/company/types.js';
import type { ISandboxDriver } from '@mcp/services/sandbox/ports/sandbox-driver.js';

const FAKE_DRIVER = {} as unknown as ISandboxDriver;

function makeBinding(overrides: Partial<SandboxBinding> = {}): SandboxBinding {
  return {
    driver: FAKE_DRIVER,
    containerId: 'cid',
    workdir: '/app',
    previewUrl: '/preview/x/',
    hostWorkdirMount: 'D:\\virt\\abc',
    ...overrides,
  };
}

function makeCtx(opts: { binding?: SandboxBinding | null; cwd?: string } = {}): ToolContext {
  const cwd = opts.cwd ?? '/legacy/cwd';
  if (opts.binding === null) {
    // Explicitly: no companyContext at all (legacy non-company runner).
    return { cwd, projectName: 'p' };
  }
  const binding = opts.binding ?? makeBinding();
  const companyContext = {
    orchestrator: {} as unknown as CompanyContext['orchestrator'],
    companySessionId: '00000000-0000-4000-8000-000000000001',
    agentRole: 'design-system-master',
    agentRunId: null,
    allowedProjectIds: [],
    isMaster: true,
    sandbox: binding,
  } as CompanyContext;
  return { cwd, projectName: 'p', companyContext };
}

describe('resolveHostPath', () => {
  it('joins relative path with hostWorkdirMount (the canonical happy path)', () => {
    const r = resolveHostPath('pkg', makeCtx());
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.path).toBe(join('D:\\virt\\abc', 'pkg'));
    }
  });

  it('translates absolute container path /app/pkg to <hostMount>/pkg', () => {
    const r = resolveHostPath('/app/pkg', makeCtx());
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.path).toBe(join('D:\\virt\\abc', 'pkg'));
    }
  });

  it('translates nested container path /app/pkg/dist/foo.tgz', () => {
    const r = resolveHostPath('/app/pkg/dist/foo.tgz', makeCtx());
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.path).toBe(join('D:\\virt\\abc', 'pkg', 'dist', 'foo.tgz'));
    }
  });

  it('returns hostMount itself when input equals workdir exactly', () => {
    const r = resolveHostPath('/app', makeCtx());
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.path).toBe('D:\\virt\\abc');
    }
  });

  it('passes absolute host paths through (already correct)', () => {
    const r = resolveHostPath('D:\\elsewhere\\pkg', makeCtx());
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.path).toBe(resolvePath('D:\\elsewhere\\pkg'));
    }
  });

  it('handles trailing slash on workdir without producing /pkg/pkg', () => {
    const ctx = makeCtx({ binding: makeBinding({ workdir: '/app/' }) });
    const r = resolveHostPath('/app/pkg', ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.path).toBe(join('D:\\virt\\abc', 'pkg'));
    }
  });

  it('handles backslash-style container path on Windows-flavoured input', () => {
    // Some agents may normalise paths to \app\pkg even though the workdir
    // is /app — we treat both separators as equivalent for prefix match.
    const r = resolveHostPath('\\app\\pkg', makeCtx());
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.path).toBe(join('D:\\virt\\abc', 'pkg'));
    }
  });

  it('falls back to ctx.cwd resolution when no companyContext at all (legacy path)', () => {
    const r = resolveHostPath('pkg', makeCtx({ binding: null, cwd: '/legacy' }));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      // Falls through to resolveAgainstCwd → join('/legacy', 'pkg')
      expect(r.path).toBe(join('/legacy', 'pkg'));
    }
  });

  it('returns no-bind-mount error when sandbox lacks hostWorkdirMount (ephemeral)', () => {
    const ctx = makeCtx({ binding: makeBinding({ hostWorkdirMount: undefined }) });
    const r = resolveHostPath('pkg', ctx);
    expect(r.kind).toBe('no-bind-mount');
    if (r.kind === 'no-bind-mount') {
      // Message must be useful — operator needs to understand WHY their
      // publish failed, not just see ENOENT. Lock the key phrases.
      expect(r.message).toMatch(/host bind-mount/);
      expect(r.message).toMatch(/node-only/);
    }
  });

  it('does not leak hostMount when input is an unrelated absolute path', () => {
    // E.g. master mistakenly passes '/etc/passwd' — we must not accidentally
    // interpret it as relative-to-host. It's absolute, doesn't match the
    // container workdir prefix, so it passes through as-is.
    const r = resolveHostPath('/etc/passwd', makeCtx());
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.path).not.toContain('virt');
      expect(r.path).toBe(resolvePath('/etc/passwd'));
    }
  });

  it('produces paths using the host OS separator (sep) on relative inputs', () => {
    const r = resolveHostPath('pkg/dist', makeCtx());
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      // join() normalises to the host's `path.sep`.
      expect(r.path).toContain(`pkg${sep}dist`);
    }
  });
});
