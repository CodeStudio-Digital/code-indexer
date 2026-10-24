import assert from 'node:assert/strict';

/** Probe from a separate process/profile while the product worker is active.
 * It performs admission only; it never executes a provider or capability. */
export async function probeOtherProfile(app, { projectRoot, generation, nativeLease = false }) {
  const result = await app.evaluate(async ({ app }, input) => {
    const { join } = process.getBuiltinModule('node:path');
    const { spawn } = process.getBuiltinModule('node:child_process');
    const dist = join(app.getAppPath(), 'dist');
    const packageDirectory = join(app.isPackaged ? process.resourcesPath : dist,
      'native-agent-runtime', 'x86_64-pc-windows-msvc');
    const profile = join(process.env.MCP_RUNTIME_COORDINATION_DIR, 'other-profile');
    const source = `
      const { join } = require('node:path');
      (async () => {
        try {
          if (process.argv[5] === 'native-lease') {
            const { nativeWorkspaceLeaseGroup } = require(join(process.argv[1], 'apps/http-api/native-workspace-lease-group.js'));
            const { verifyRuntimePackage, parseRuntimePackageAnchor } = require(join(process.argv[1], 'packages/agent-runtime-host/src/index.js'));
            const runtime = await verifyRuntimePackage(process.argv[6], parseRuntimePackageAnchor(
              await require('node:fs/promises').readFile(join(process.argv[1], 'apps/electron/native-agent-runtime-integrity.json'))));
            const leases = nativeWorkspaceLeaseGroup({ workspaceLeaseRoot: join(process.env.MCP_DATA_DIR, 'native-workspace-leases'),
              sharedWorkspaceLeaseRoot: join(process.env.MCP_RUNTIME_COORDINATION_DIR, 'native-workspace-leases') }, runtime);
            const lease = await leases.acquire({ root: process.argv[3], ownerAgentRunId: 'probe-run', attemptId: 'probe-attempt',
              access: 'exclusive_write', expiresAtUnixMs: Date.now() + 30_000, assertOwner: async () => {} });
            await leases.release(lease, async () => {});
          } else {
            const { WorkspaceRuntimeScope } = require(join(process.argv[1], 'packages/code-agent/src/runtime/workspace-runtime-cohort.js'));
            const scope = new WorkspaceRuntimeScope(process.argv[4]);
            await scope.enter(process.argv[2], 'cross-profile-probe', [process.argv[3]]);
            await scope.close(true);
          }
          console.log(JSON.stringify({ admitted: true, pid: process.pid }));
        } catch (cause) {
          console.log(JSON.stringify({ admitted: false, code: cause.code, message: cause.message, pid: process.pid }));
        }
      })().catch(cause => { console.error(String(cause)); process.exitCode = 1; });
    `;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', source, dist, join(profile, 'index.db'), input.projectRoot,
        input.generation, input.nativeLease ? 'native-lease' : 'cohort', packageDirectory], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MCP_DATA_DIR: profile, MCP_INDEX_DB: join(profile, 'index.db'),
          CODESTUDIO_NATIVE_CODER_DEV: '0', CODESTUDIO_RUNTIME_COHORT_GUARD: '0' },
      });
      let output = ''; let errors = ''; let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 15_000);
      child.stdout.on('data', bytes => { output += bytes.toString(); if (output.length > 65_536) child.kill(); });
      child.stderr.on('data', bytes => { errors = (errors + bytes.toString()).slice(-4_096); });
      child.on('error', cause => { clearTimeout(timeout); reject(cause); });
      child.on('close', code => {
        clearTimeout(timeout);
        if (code !== 0 || timedOut) { reject(new Error(`Profile probe failed (${code}): ${errors}`)); return; }
        try { resolve({ ...JSON.parse(output.trim().split('\n').at(-1)), profile, processExited: true }); }
        catch (cause) { reject(cause); }
      });
    });
  }, { projectRoot, generation, nativeLease });
  assert.equal(result.admitted, false, 'another profile bypassed active workspace ownership');
  assert.equal(result.code, 'WORKSPACE_RUNTIME_CONFLICT');
  assert.equal(result.processExited, true);
  return result;
}
