import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import plugin, {
  debugAdapter,
  wranglerInspectorPort,
} from '../../../../extensions/javascript-debugger/src/plugin.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('javascript debugger plugin', () => {
  it('declares JavaScript and TypeScript support', () => {
    expect(plugin.debuggers).toHaveLength(1);
    expect(plugin.debuggers[0].id).toBe('javascript');
    expect(plugin.debuggers[0].languageIds).toContain('typescript');
  });

  it('resolves the pinned standalone adapter inside the installed plugin', () => {
    const executable = debugAdapter.resolveAdapter({
      pluginRoot: 'C:\\plugins\\javascript-debugger',
      projectRoot: 'C:\\project',
      platform: 'win32',
      nodePath: 'C:\\node\\node.exe',
    });
    expect(executable.command).toBe('C:\\node\\node.exe');
    expect(executable.args?.[0]).toContain('dapDebugServer.js');
    expect(executable.args).toContain('__MCP_DEBUG_PORT__');
    expect(executable.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '',
      TSX_TSCONFIG_PATH: '',
    });
    expect(executable.transport).toMatchObject({ kind: 'tcp', host: '127.0.0.1' });
  });

  it('resolves a source file launch', () => {
    expect(debugAdapter.resolveConfiguration({
      request: 'launch',
      projectRoot: '/work',
      file: '/work/src/index.ts',
      args: ['one'],
    })).toMatchObject({
      type: 'pwa-node',
      request: 'launch',
      program: '/work/src/index.ts',
      args: ['one'],
      sourceMaps: true,
    });
  });

  it('resolves a package script without parsing a shell command', () => {
    expect(debugAdapter.resolveConfiguration({
      request: 'launch',
      projectRoot: '/work',
      runner: { manager: 'pnpm', script: 'dev', args: ['--host'] },
    })).toMatchObject({
      runtimeExecutable: 'pnpm',
      runtimeArgs: ['run', 'dev', '--host'],
      cwd: '/work',
      autoAttachChildProcesses: true,
    });
  });

  it('connects a wrangler runner to the workerd inspector', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'mcp-js-debug-wrangler-'));
    tempDirectories.push(projectRoot);
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({
      scripts: { dev: 'wrangler dev --inspector-port=9333' },
    }));

    expect(debugAdapter.resolveConfiguration({
      request: 'launch',
      projectRoot,
      runner: { manager: 'npm', script: 'dev' },
    })).toMatchObject({
      runtimeExecutable: 'npm',
      runtimeArgs: ['run', 'dev'],
      attachSimplePort: 9333,
      autoAttachChildProcesses: false,
      resolveSourceMapLocations: null,
    });
  });

  it('uses Wrangler default inspector port when none is explicit', () => {
    expect(wranglerInspectorPort('wrangler dev --port 8282')).toBe(9229);
    expect(wranglerInspectorPort('vite dev')).toBeNull();
  });

  it('requires a structured launch target', () => {
    expect(() => debugAdapter.resolveConfiguration({ request: 'launch', projectRoot: '/work' })).toThrow(
      'requires a file or runner',
    );
  });
});
