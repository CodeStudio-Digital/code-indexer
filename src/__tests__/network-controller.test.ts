import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NetworkController } from '@mcp/services/sandbox/network-controller.js';
import type {
  IShellPort,
  ShellExecOptions,
  ShellExecResult,
  ShellRunOptions,
} from '@mcp/code-agent/ports/shell-port.js';

/**
 * In-memory shell port that plays back scripted responses keyed on the
 * first two argv tokens (e.g. `docker network` / `docker inspect` /
 * `docker image` / `docker run`). The test sets up a response table
 * and asserts both the returned NetworkInfo and the captured argv.
 */
class ScriptedShell implements IShellPort {
  readonly runs: Array<{ program: string; args: string[] }> = [];
  responses: Array<(args: string[]) => ShellExecResult> = [];

  async exec(_cmd: string, _opts: ShellExecOptions): Promise<ShellExecResult> {
    throw new Error('exec() not used by NetworkController');
  }
  async run(program: string, args: string[], _opts: ShellRunOptions): Promise<ShellExecResult> {
    return this.dispatch(program, args);
  }
  async spawn(program: string, args: string[], _opts: ShellExecOptions): Promise<ShellExecResult> {
    return this.dispatch(program, args);
  }

  private dispatch(program: string, args: string[]): ShellExecResult {
    this.runs.push({ program, args });
    const handler = this.responses.shift();
    if (!handler) {
      throw new Error(`ScriptedShell: no response queued for ${program} ${args.join(' ')}`);
    }
    return handler(args);
  }
}

function ok(stdout = ''): ShellExecResult {
  return { stdout, stderr: '', exitCode: 0, timedOut: false };
}
function fail(stderr = 'boom', exitCode = 1): ShellExecResult {
  return { stdout: '', stderr, exitCode, timedOut: false };
}

describe('NetworkController', () => {
  const prevEnv = process.env.MCP_SANDBOX_EGRESS_FIREWALL;

  beforeEach(() => {
    process.env.MCP_SANDBOX_EGRESS_FIREWALL = '1';
  });
  afterEach(() => {
    process.env.MCP_SANDBOX_EGRESS_FIREWALL = prevEnv;
  });

  it('returns null when the firewall is disabled', async () => {
    delete process.env.MCP_SANDBOX_EGRESS_FIREWALL;
    const shell = new ScriptedShell();
    const nc = new NetworkController({ shell });
    expect(await nc.ensure()).toBeNull();
    // And no CLI calls should have been issued.
    expect(shell.runs).toHaveLength(0);
  });

  it('creates the network and starts the proxy when neither exist', async () => {
    const shell = new ScriptedShell();
    // network inspect — missing. Create — ok.
    // container inspect — missing. image inspect — ok. run — ok.
    shell.responses = [
      () => fail('No such network', 1),
      () => ok('created'),
      () => fail('No such object', 1),
      () => ok('{}'), // image inspect
      () => ok('container-id'),
    ];
    const nc = new NetworkController({ shell });
    const info = await nc.ensure();
    expect(info).toEqual({
      networkName: 'mcp-sandbox-net',
      proxyUrl: 'http://mcp-sandbox-squid:3128',
    });
    // Verify the CLI sequence matches the intended choreography.
    expect(shell.runs.map((r) => r.args.slice(0, 2).join(' '))).toEqual([
      'network inspect',
      'network create',
      'inspect --format',
      'image inspect',
      'run -d',
    ]);
    // The `run` invocation must attach to our network and use restart=always.
    const runArgs = shell.runs.at(-1)!.args;
    expect(runArgs).toContain('--network');
    expect(runArgs).toContain('mcp-sandbox-net');
    expect(runArgs).toContain('--restart=always');
  });

  it('skips setup when the network and a running proxy already exist', async () => {
    const shell = new ScriptedShell();
    shell.responses = [
      () => ok(), // network inspect → exists
      () => ok('true'), // proxy inspect → running
    ];
    const nc = new NetworkController({ shell });
    await nc.ensure();
    expect(shell.runs).toHaveLength(2);
  });

  it('removes a stopped proxy container and starts a fresh one', async () => {
    const shell = new ScriptedShell();
    shell.responses = [
      () => ok(), // network exists
      () => ok('false'), // proxy inspect → exists but stopped
      () => ok(), // rm -f
      () => ok(), // image inspect
      () => ok('new-id'), // run -d
    ];
    const nc = new NetworkController({ shell });
    await nc.ensure();
    expect(shell.runs.map((r) => r.args[0])).toEqual([
      'network',
      'inspect',
      'rm',
      'image',
      'run',
    ]);
  });

  it('surfaces a helpful error when the proxy image is missing', async () => {
    const shell = new ScriptedShell();
    shell.responses = [
      () => ok(), // network exists
      () => fail('No such object', 1), // proxy container missing
      () => fail('No such image', 1), // image inspect fails
    ];
    const nc = new NetworkController({ shell });
    await expect(nc.ensure()).rejects.toThrow(/mcp-sandbox-squid.*not found/);
  });
});
