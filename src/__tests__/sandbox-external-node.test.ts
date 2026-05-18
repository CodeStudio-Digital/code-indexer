import { describe, it, expect } from 'vitest';
import {
  inferExternalNodeScriptPort,
  inferExternalNodeFramework,
  inferExternalNodePort,
  externalNodeInstallCommand,
  externalNodeRunArgs,
  externalNodeRunCommand,
  externalNodeDependencyProbeCommand,
  type ExternalNodeDevSpec,
} from '@mcp/services/sandbox/manager/external-node.js';
import type {
  NodeManifest,
  NodePackageManager,
} from '@mcp/services/sandbox/manifest-detector/types.js';

// ─── inferExternalNodeScriptPort ────────────────────────────────

describe('inferExternalNodeScriptPort', () => {
  it('extracts port from `--port 1234`', () => {
    expect(inferExternalNodeScriptPort('vite --port 5678')).toBe(5678);
  });

  it('extracts port from `--port=1234`', () => {
    expect(inferExternalNodeScriptPort('vite --port=4200')).toBe(4200);
  });

  it('extracts port from short form `-p 1234`', () => {
    expect(inferExternalNodeScriptPort('next dev -p 3001')).toBe(3001);
  });

  it('returns null when no port flag is present', () => {
    expect(inferExternalNodeScriptPort('vite')).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(inferExternalNodeScriptPort('')).toBeNull();
  });

  it('rejects ports out of range', () => {
    expect(inferExternalNodeScriptPort('vite --port=99999')).toBeNull();
    expect(inferExternalNodeScriptPort('vite --port=0')).toBeNull();
  });

  it('does not match port-like substrings inside other flags', () => {
    expect(inferExternalNodeScriptPort('vite --transport=1234')).toBeNull();
  });
});

// ─── inferExternalNodeFramework ─────────────────────────────────

describe('inferExternalNodeFramework', () => {
  it('detects Angular via stack', () => {
    expect(inferExternalNodeFramework('angular', 'ng serve')).toBe('angular');
  });

  it('detects Angular via script even on a different stack', () => {
    expect(inferExternalNodeFramework('react-ts', 'ng serve --port 4200')).toBe('angular');
  });

  it('detects Next.js via `next dev`', () => {
    expect(inferExternalNodeFramework('react-ts', 'next dev -p 3000')).toBe('next');
  });

  it('detects Next.js via `next start`', () => {
    expect(inferExternalNodeFramework('react-ts', 'next start')).toBe('next');
  });

  it('detects Vite when the binary name appears', () => {
    expect(inferExternalNodeFramework('react-ts', 'vite --port 5173')).toBe('vite');
  });

  it('falls back to generic for plain custom scripts', () => {
    expect(inferExternalNodeFramework('react-ts', 'node server.js')).toBe('generic');
  });

  it('is case-insensitive', () => {
    expect(inferExternalNodeFramework('react-ts', 'NG SERVE')).toBe('angular');
  });
});

// ─── inferExternalNodePort ──────────────────────────────────────

describe('inferExternalNodePort', () => {
  it('returns 4200 for Angular', () => {
    expect(inferExternalNodePort('angular', 5173)).toBe(4200);
  });

  it('returns 3000 for Next', () => {
    expect(inferExternalNodePort('next', 5173)).toBe(3000);
  });

  it('returns the default for Vite', () => {
    expect(inferExternalNodePort('vite', 5173)).toBe(5173);
  });

  it('returns the default for generic', () => {
    expect(inferExternalNodePort('generic', 8080)).toBe(8080);
  });
});

// ─── externalNodeInstallCommand ─────────────────────────────────

describe('externalNodeInstallCommand', () => {
  it('npm uses standard install with quiet flags', () => {
    expect(externalNodeInstallCommand('npm')).toBe(
      'npm install --no-audit --no-fund --loglevel=error',
    );
  });

  it('pnpm wraps with corepack toggle and `--frozen-lockfile=false`', () => {
    const cmd = externalNodeInstallCommand('pnpm');
    expect(cmd).toContain('corepack enable');
    expect(cmd).toContain('pnpm install --frozen-lockfile=false');
  });

  it('yarn wraps with corepack toggle', () => {
    const cmd = externalNodeInstallCommand('yarn');
    expect(cmd).toContain('corepack enable');
    expect(cmd).toContain('yarn install');
  });
});

// ─── externalNodeRunArgs ────────────────────────────────────────

function makeSpec(overrides: Partial<ExternalNodeDevSpec> = {}): ExternalNodeDevSpec {
  return {
    manifest: { kind: 'node' } as NodeManifest,
    packageManager: 'npm' as NodePackageManager,
    scriptName: 'dev',
    scriptBody: 'vite',
    containerPort: 5173,
    framework: 'vite',
    ...overrides,
  };
}

describe('externalNodeRunArgs', () => {
  it('Vite: adds --host, --port, and --base when none are present', () => {
    const out = externalNodeRunArgs(makeSpec(), '/preview/42/');
    expect(out).toContain('--host 0.0.0.0');
    expect(out).toContain('--port 5173');
    expect(out).toContain('--base=/preview/42/');
  });

  it('Vite: does NOT duplicate --host when user already supplied it', () => {
    const out = externalNodeRunArgs(makeSpec({ scriptBody: 'vite --host 0.0.0.0' }), '/preview/42/');
    expect(out.match(/--host/g)?.length ?? 0).toBe(0);
  });

  it('Vite: does NOT duplicate --port when user already supplied it', () => {
    const out = externalNodeRunArgs(makeSpec({ scriptBody: 'vite --port 5173' }), '/preview/42/');
    expect(out.match(/--port/g)?.length ?? 0).toBe(0);
  });

  it('Vite: does NOT duplicate --base when user already supplied it', () => {
    const out = externalNodeRunArgs(makeSpec({ scriptBody: 'vite --base /custom/' }), '/preview/42/');
    expect(out).not.toContain('--base=');
  });

  it('Next: uses --hostname instead of --host', () => {
    const out = externalNodeRunArgs(
      makeSpec({ framework: 'next', scriptBody: 'next dev', containerPort: 3000 }),
      '/preview/42/',
    );
    expect(out).toContain('--hostname 0.0.0.0');
    expect(out).toContain('--port 3000');
    expect(out).not.toContain('--base');
  });

  it('Next: respects --hostname when user supplied it', () => {
    const out = externalNodeRunArgs(
      makeSpec({ framework: 'next', scriptBody: 'next dev --hostname localhost' }),
      '/preview/42/',
    );
    expect(out).not.toContain('--hostname');
  });

  it('Angular: adds --disable-host-check, --poll, --serve-path', () => {
    const out = externalNodeRunArgs(
      makeSpec({ framework: 'angular', scriptBody: 'ng serve', containerPort: 4200 }),
      '/preview/42/',
    );
    expect(out).toContain('--disable-host-check');
    expect(out).toContain('--poll=300');
    expect(out).toContain('--serve-path=/preview/42/');
  });

  it('Angular: skips flags already in script', () => {
    const out = externalNodeRunArgs(
      makeSpec({
        framework: 'angular',
        scriptBody: 'ng serve --disable-host-check --poll=100',
      }),
      '/preview/42/',
    );
    expect(out).not.toContain('--disable-host-check');
    expect(out).not.toContain('--poll=300');
    expect(out).toContain('--serve-path=/preview/42/');
  });

  it('generic: only host + port', () => {
    const out = externalNodeRunArgs(
      makeSpec({ framework: 'generic', scriptBody: 'node server.js' }),
      '/preview/42/',
    );
    expect(out).toBe('--host 0.0.0.0 --port 5173');
  });
});

// ─── externalNodeRunCommand ─────────────────────────────────────

describe('externalNodeRunCommand', () => {
  it('npm: no corepack, uses `npm run <script> -- <args>`', () => {
    const cmd = externalNodeRunCommand(makeSpec(), '/preview/42/');
    expect(cmd).not.toContain('corepack');
    expect(cmd).toMatch(/^npm run dev/);
    expect(cmd).toContain(' -- --host 0.0.0.0 --port 5173 --base=/preview/42/');
  });

  it('pnpm: corepack prefix + `pnpm run <script>`', () => {
    const cmd = externalNodeRunCommand(makeSpec({ packageManager: 'pnpm' }), '/preview/42/');
    expect(cmd).toContain('corepack enable');
    expect(cmd).toContain('pnpm run dev');
  });

  it('yarn: corepack prefix + `yarn <script>` (no `run`)', () => {
    const cmd = externalNodeRunCommand(makeSpec({ packageManager: 'yarn' }), '/preview/42/');
    expect(cmd).toContain('corepack enable');
    expect(cmd).toContain('yarn dev');
    expect(cmd).not.toContain('yarn run');
  });

  it('omits the `-- <args>` separator when there are no extra args', () => {
    // Script with everything already inline → externalNodeRunArgs returns ''.
    const cmd = externalNodeRunCommand(
      makeSpec({ scriptBody: 'vite --host 0.0.0.0 --port 5173 --base=/preview/42/' }),
      '/preview/42/',
    );
    expect(cmd).not.toContain(' -- ');
  });
});

// ─── externalNodeDependencyProbeCommand ─────────────────────────

describe('externalNodeDependencyProbeCommand', () => {
  it('checks node_modules existence + bundler resolveability', () => {
    const cmd = externalNodeDependencyProbeCommand();
    expect(cmd).toContain('test -d node_modules');
    expect(cmd).toContain('node_modules/.bin');
    expect(cmd).toContain('rollup');
    expect(cmd).toContain('esbuild');
  });

  it('is deterministic — same output every call', () => {
    expect(externalNodeDependencyProbeCommand()).toBe(externalNodeDependencyProbeCommand());
  });
});
