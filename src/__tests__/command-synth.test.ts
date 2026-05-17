import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateArgv, ALLOWED_PROGRAMS } from '@mcp/services/sandbox/command-synth/allowlist.js';
import { fallbackCommand } from '@mcp/services/sandbox/command-synth/fallback-rules.js';
import type { ManifestInfo } from '@mcp/services/sandbox/manifest-detector/types.js';
import { extractFirstJson } from '@mcp/services/ai-general/extract-json.js';

describe('validateArgv', () => {
  it('accepts npm run dev with a PORT env', () => {
    expect(validateArgv('npm', ['run', 'dev'])).toEqual({ ok: true });
  });

  it('rejects bash, sh, cmd, powershell', () => {
    for (const p of ['bash', 'sh', 'cmd', 'powershell', 'zsh']) {
      expect(validateArgv(p, []).ok).toBe(false);
    }
  });

  it('rejects programs containing path separators', () => {
    expect(validateArgv('./node', []).ok).toBe(false);
    expect(validateArgv('C:\\node.exe', []).ok).toBe(false);
    expect(validateArgv('/usr/bin/node', []).ok).toBe(false);
  });

  it('rejects -c, -e, --eval, --exec, --command flags', () => {
    expect(validateArgv('node', ['-e', 'require("fs")']).ok).toBe(false);
    expect(validateArgv('python', ['-c', 'import os']).ok).toBe(false);
    expect(validateArgv('node', ['--eval', 'x']).ok).toBe(false);
    expect(validateArgv('node', ['--eval=x']).ok).toBe(false);
    expect(validateArgv('ruby', ['-e', 'x']).ok).toBe(false);
    expect(validateArgv('node', ['--exec', 'x']).ok).toBe(false);
    expect(validateArgv('npm', ['--command', 'rm']).ok).toBe(false);
  });

  it('rejects non-string argv entries', () => {
    expect(validateArgv('npm', [123 as unknown as string]).ok).toBe(false);
  });

  it('accepts flags that merely share a prefix but arent banned', () => {
    // --error-log, --config are fine — only explicit prefixes are banned.
    expect(validateArgv('npm', ['--config', 'x']).ok).toBe(true);
    // But --exec is explicitly banned, so anything starting with it trips.
    expect(validateArgv('npm', ['--exec=x']).ok).toBe(false);
  });

  it('has every expected runtime on the allowlist', () => {
    for (const p of ['npm', 'pnpm', 'yarn', 'node', 'python', 'go', 'cargo', 'ruby', 'bundle']) {
      expect(ALLOWED_PROGRAMS.has(p)).toBe(true);
    }
  });
});

describe('fallbackCommand', () => {
  const PORT = 34123;

  it('node with dev script → npm run dev with PORT', () => {
    const m: ManifestInfo = {
      kind: 'node',
      rootPath: '/tmp/x',
      manifestPath: '/tmp/x/package.json',
      packageManager: 'npm',
      scripts: { dev: 'vite' },
      devScriptName: 'dev',
      packageName: 'demo',
      hasNodeModules: true,
    };
    const cmd = fallbackCommand(m, PORT);
    expect(cmd.program).toBe('npm');
    expect(cmd.args).toEqual(['run', 'dev']);
    expect(cmd.env.PORT).toBe('34123');
    expect(validateArgv(cmd.program, cmd.args).ok).toBe(true);
  });

  it('node fallback always uses npm (avoid ENOENT when yarn/pnpm missing)', () => {
    // packageManager='pnpm' is informational; the fallback still uses
    // npm (ships with node, no install gate). AI path can pick pnpm.
    const m: ManifestInfo = {
      kind: 'node',
      rootPath: '/tmp/y',
      manifestPath: '/tmp/y/package.json',
      packageManager: 'pnpm',
      scripts: { start: 'node index.js' },
      devScriptName: 'start',
      packageName: null,
      hasNodeModules: false,
    };
    const cmd = fallbackCommand(m, PORT);
    expect(cmd.program).toBe('npm');
    expect(cmd.args).toEqual(['run', 'start']);
    expect(cmd.rationale).toMatch(/pnpm/);
  });

  it('python fastapi → uvicorn with detected entry', () => {
    const m: ManifestInfo = {
      kind: 'python',
      rootPath: '/tmp/p',
      manifestPath: '/tmp/p/pyproject.toml',
      framework: 'fastapi',
      entry: 'main:app',
    };
    const cmd = fallbackCommand(m, PORT);
    expect(cmd.program).toBe('uvicorn');
    expect(cmd.args).toEqual(['main:app', '--host', '127.0.0.1', '--port', '34123']);
    expect(validateArgv(cmd.program, cmd.args).ok).toBe(true);
  });

  it('python django → python manage.py runserver', () => {
    const m: ManifestInfo = {
      kind: 'python',
      rootPath: '/tmp/d',
      manifestPath: '/tmp/d/pyproject.toml',
      framework: 'django',
      entry: null,
    };
    const cmd = fallbackCommand(m, PORT);
    expect(cmd.program).toBe('python');
    expect(cmd.args).toEqual(['manage.py', 'runserver', '127.0.0.1:34123']);
  });

  it('python flask → flask run', () => {
    const m: ManifestInfo = {
      kind: 'python',
      rootPath: '/tmp/f',
      manifestPath: '/tmp/f/pyproject.toml',
      framework: 'flask',
      entry: 'app:app',
    };
    const cmd = fallbackCommand(m, PORT);
    expect(cmd.program).toBe('flask');
    expect(cmd.args).toEqual(['run', '--host', '127.0.0.1', '--port', '34123']);
  });

  it('go → go run . with PORT env', () => {
    const m: ManifestInfo = {
      kind: 'go',
      rootPath: '/tmp/g',
      manifestPath: '/tmp/g/go.mod',
      moduleName: 'example.com/demo',
      hasMainGo: true,
    };
    const cmd = fallbackCommand(m, PORT);
    expect(cmd).toMatchObject({ program: 'go', args: ['run', '.'] });
    expect(cmd.env.PORT).toBe('34123');
  });

  it('rust with single [[bin]] → cargo run --bin', () => {
    const m: ManifestInfo = {
      kind: 'rust',
      rootPath: '/tmp/r',
      manifestPath: '/tmp/r/Cargo.toml',
      packageName: 'pkg',
      binaries: ['api'],
    };
    const cmd = fallbackCommand(m, PORT);
    expect(cmd.args).toEqual(['run', '--bin', 'api']);
  });

  it('rust without bins → cargo run', () => {
    const m: ManifestInfo = {
      kind: 'rust',
      rootPath: '/tmp/r2',
      manifestPath: '/tmp/r2/Cargo.toml',
      packageName: 'pkg',
      binaries: [],
    };
    const cmd = fallbackCommand(m, PORT);
    expect(cmd.args).toEqual(['run']);
  });

  it('ruby rails → bundle exec rails server -p <port>', () => {
    const m: ManifestInfo = {
      kind: 'ruby',
      rootPath: '/tmp/rb',
      manifestPath: '/tmp/rb/Gemfile',
      framework: 'rails',
    };
    const cmd = fallbackCommand(m, PORT);
    expect(cmd.program).toBe('bundle');
    expect(cmd.args).toEqual(['exec', 'rails', 'server', '-b', '127.0.0.1', '-p', '34123']);
    expect(validateArgv(cmd.program, cmd.args).ok).toBe(true);
  });

  it('every fallback command passes validateArgv', () => {
    const cases: ManifestInfo[] = [
      {
        kind: 'node',
        rootPath: '/a',
        manifestPath: '/a/package.json',
        packageManager: 'yarn',
        scripts: { dev: 'x' },
        devScriptName: 'dev',
        packageName: null,
        hasNodeModules: false,
      },
      {
        kind: 'python',
        rootPath: '/b',
        manifestPath: '/b/pyproject.toml',
        framework: 'unknown',
        entry: null,
      },
      {
        kind: 'go',
        rootPath: '/c',
        manifestPath: '/c/go.mod',
        moduleName: 'x',
        hasMainGo: false,
      },
      {
        kind: 'rust',
        rootPath: '/d',
        manifestPath: '/d/Cargo.toml',
        packageName: 'x',
        binaries: [],
      },
      {
        kind: 'ruby',
        rootPath: '/e',
        manifestPath: '/e/Gemfile',
        framework: 'sinatra',
      },
    ];
    for (const m of cases) {
      const cmd = fallbackCommand(m, PORT);
      const v = validateArgv(cmd.program, cmd.args);
      expect(v, `validation failed for kind=${m.kind}: ${v.reason ?? ''}`).toEqual({ ok: true });
    }
  });
});

describe('synthesizeStartCommand', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('../core/ai-general/generalClient.js');
  });

  const NODE_MANIFEST: ManifestInfo = {
    kind: 'node',
    rootPath: '/tmp/x',
    manifestPath: '/tmp/x/package.json',
    packageManager: 'npm',
    scripts: { dev: 'vite' },
    devScriptName: 'dev',
    packageName: 'demo',
    hasNodeModules: true,
  };

  it('uses fallback when useAi is false', async () => {
    const { synthesizeStartCommand } = await import('@mcp/services/sandbox/command-synth/synthesize.js');
    const r = await synthesizeStartCommand(NODE_MANIFEST, 34100, { useAi: false });
    expect(r.source).toBe('fallback');
    expect(r.command.program).toBe('npm');
  });

  it('falls back when AI is not configured', async () => {
    vi.doMock('@mcp/services/ai-general/generalClient.js', () => ({
      GeneralAiNotConfiguredError: class GeneralAiNotConfiguredError extends Error {
        constructor() {
          super('not configured');
          this.name = 'GeneralAiNotConfiguredError';
        }
      },
      runGeneralAi: vi.fn(async () => {
        const { GeneralAiNotConfiguredError } = await import('@mcp/services/ai-general/generalClient.js');
        throw new GeneralAiNotConfiguredError();
      }),
    }));
    const { synthesizeStartCommand } = await import('@mcp/services/sandbox/command-synth/synthesize.js');
    const r = await synthesizeStartCommand(NODE_MANIFEST, 34100, { useAi: true });
    expect(r.source).toBe('fallback');
  });

  it('uses AI output when valid', async () => {
    vi.doMock('@mcp/services/ai-general/generalClient.js', () => ({
      GeneralAiNotConfiguredError: class extends Error {},
      runGeneralAi: vi.fn(
        async () =>
          '{"program":"npx","args":["vite","--port","34100","--host","127.0.0.1"],' +
          '"env":{},"readyProbe":{"kind":"http","path":"/"},"rationale":"direct vite"}',
      ),
    }));
    const { synthesizeStartCommand } = await import('@mcp/services/sandbox/command-synth/synthesize.js');
    const r = await synthesizeStartCommand(NODE_MANIFEST, 34100, { useAi: true });
    expect(r.source).toBe('ai');
    expect(r.command.program).toBe('npx');
    expect(r.command.args).toContain('--port');
    expect(r.command.args).toContain('34100');
  });

  it('falls back when AI picks a banned program', async () => {
    vi.doMock('@mcp/services/ai-general/generalClient.js', () => ({
      GeneralAiNotConfiguredError: class extends Error {},
      runGeneralAi: vi.fn(
        async () =>
          '{"program":"bash","args":["-c","npm run dev"],"env":{},' +
          '"readyProbe":{"kind":"http","path":"/"},"rationale":"shell"}',
      ),
    }));
    const { synthesizeStartCommand } = await import('@mcp/services/sandbox/command-synth/synthesize.js');
    const r = await synthesizeStartCommand(NODE_MANIFEST, 34100, { useAi: true });
    expect(r.source).toBe('fallback-after-ai-failure');
    expect(r.aiFailureReason).toMatch(/allowlist/);
    expect(r.command.program).toBe('npm'); // fallback
  });

  it('falls back when AI returns non-JSON', async () => {
    vi.doMock('@mcp/services/ai-general/generalClient.js', () => ({
      GeneralAiNotConfiguredError: class extends Error {},
      runGeneralAi: vi.fn(async () => 'I would run `npm run dev`.'),
    }));
    const { synthesizeStartCommand } = await import('@mcp/services/sandbox/command-synth/synthesize.js');
    const r = await synthesizeStartCommand(NODE_MANIFEST, 34100, { useAi: true });
    expect(r.source).toBe('fallback-after-ai-failure');
  });

  it('falls back when AI returns JSON with wrong shape', async () => {
    vi.doMock('@mcp/services/ai-general/generalClient.js', () => ({
      GeneralAiNotConfiguredError: class extends Error {},
      runGeneralAi: vi.fn(async () => '{"program":"npm"}'),
    }));
    const { synthesizeStartCommand } = await import('@mcp/services/sandbox/command-synth/synthesize.js');
    const r = await synthesizeStartCommand(NODE_MANIFEST, 34100, { useAi: true });
    expect(r.source).toBe('fallback-after-ai-failure');
  });
});

describe('extractFirstJson', () => {
  it('parses raw JSON', () => {
    expect(extractFirstJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON wrapped in markdown fence', () => {
    expect(extractFirstJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses JSON after prose', () => {
    expect(extractFirstJson('Sure, here you go: {"a":1}')).toEqual({ a: 1 });
  });

  it('returns null on garbage', () => {
    expect(extractFirstJson('not json at all')).toBeNull();
  });

  it('handles nested objects', () => {
    expect(extractFirstJson('{"a":{"b":2}}')).toEqual({ a: { b: 2 } });
  });
});
