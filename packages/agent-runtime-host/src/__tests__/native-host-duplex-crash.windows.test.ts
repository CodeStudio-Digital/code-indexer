import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { verifyRuntimePackage } from '../packaging/RuntimePackageVerifier.js';
import { parseRuntimePackageAnchor } from '../packaging/RuntimePackageManifest.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;

physicalIt('kills the stdio server and its detached descendant when the native Host owner crashes', async () => {
  const runtime = await verifyRuntimePackage(resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
    parseRuntimePackageAnchor(await readFile('dist/apps/electron/native-agent-runtime-integrity.json')));
  const directory = await mkdtemp(join(tmpdir(), 'native-host-duplex-crash-'));
  const fixture = join(directory, 'host.cjs');
  const proof = join(directory, 'processes.json');
  await writeFile(fixture, `
const bridge = require(process.argv[2]);
const proof = process.argv[3];
const childCode = 'setInterval(() => {}, 1000)';
const commandCode = [
  'const { spawn } = require("node:child_process");',
  'const child = spawn(process.execPath, ["-e", ' + JSON.stringify(childCode) + '], { detached: true, stdio: "ignore", windowsHide: true });',
  'require("node:fs").writeFileSync(' + JSON.stringify(proof) + ', JSON.stringify({ root: process.pid, child: child.pid }));',
  'setInterval(() => {}, 1000);'
].join('');
global.command = bridge.startNativeHostDuplexProcess({ executable: process.execPath, arguments: ['-e', commandCode],
  cwd: require('node:path').dirname(proof), environment: process.env, 
  timeoutMs: 30000 });
process.send({ root: global.command.processId });
global.command.wait().then(result => { process.send({ unexpectedExit: result.exitCode }); }, error => { throw error; });
`);
  const host = spawn(process.execPath, [fixture, runtime.binaries.hostBridge.absolutePath, proof], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
  });
  let pids: { root: number; child: number } | undefined;
  const hostClosed = once(host, 'exit');
  let diagnostics = '';
  host.stderr!.on('data', bytes => { diagnostics = (diagnostics + String(bytes)).slice(-2048); });
  try {
    await vi.waitFor(async () => {
      pids = JSON.parse(await readFile(proof, 'utf8'));
      expect(Number.isInteger(pids!.root) && pids!.root > 0, diagnostics).toBe(true);
      expect(Number.isInteger(pids!.child) && pids!.child > 0, diagnostics).toBe(true);
      expect(alive(pids!.root), diagnostics).toBe(true);
      expect(alive(pids!.child), diagnostics).toBe(true);
    }, { timeout: 10_000, interval: 25 });
    expect(host.kill('SIGKILL')).toBe(true);
    await hostClosed;
    await vi.waitFor(() => {
      expect(alive(pids!.root), 'command survived Host crash').toBe(false);
      expect(alive(pids!.child), 'detached descendant survived Host crash').toBe(false);
    }, { timeout: 5_000, interval: 25 });
  } finally {
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
    await hostClosed;
    // Only fixture-owned PIDs; failures remain test failures before cleanup.
    for (const pid of pids ? [pids.root, pids.child] : []) {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 25_000);

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
