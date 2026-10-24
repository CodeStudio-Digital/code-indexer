const path = require('node:path');
const { mkdtemp, writeFile, rm, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');

module.exports = async function probeAgentLsp(asar) {
  let root, port;
  try {
    const { NativeLspPort } = require(path.join(asar, 'dist/apps/http-api/workers/native-lsp-port.js'));
    const { verifyRuntimePackage, parseRuntimePackageAnchor, loadNativeHostBridge } = require(path.join(asar, 'dist/packages/agent-runtime-host/src/index.js'));
    const packaged = asar.endsWith('app.asar');
    const packageDirectory = path.join(packaged ? path.dirname(asar) : path.join(asar, 'dist'), 'native-agent-runtime', 'x86_64-pc-windows-msvc');
    const anchor = parseRuntimePackageAnchor(await readFile(path.join(asar, 'dist/apps/electron/native-agent-runtime-integrity.json')));
    const verified = await verifyRuntimePackage(packageDirectory, anchor);
    const spawn = loadNativeHostBridge(verified).startNativeHostDuplexProcess;
    if (!spawn) throw new Error('Packaged native process containment is missing');
    const options = { spawn, deadline: Date.now() + 60000 };
    root = await mkdtemp(path.join(tmpdir(), 'codestudio-lsp-probe-'));
    await writeFile(path.join(root, 'sample.ts'), 'export const value: number = "bad";');
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true, types: [] }, files: ['sample.ts'] }));
    port = new NativeLspPort(new AbortController().signal, () => {}, options);
    const query = { op: 'diagnostics', root, file: 'sample.ts', projectName: 'probe' };
    const result = await port.query(query);
    if (result.kind !== 'diagnostics' || !result.items.some(d => d.code === 2322)) throw new Error('Packaged TS worker missed a real type error');
    // Native Job reap receipts prove termination, not just cancellation ACK.
    const first = port.worker;
    await port.close();
    if (!first?.reaped) throw new Error('Warm LSP process survived owner close');
    const cancelledPids = [];
    await writeFile(path.join(root, 'cancel.ts'), Array.from({ length: 30000 }, (_, n) => `export const entry${n}: number = "bad";`).join('\n'));
    for (const delay of [0, 1, 5, 20, 50, 100, 150, 250]) {
      port = new NativeLspPort(new AbortController().signal, () => {}, options);
      const ctrl = new AbortController(), pending = port.query({ ...query, file: 'cancel.ts' }, ctrl.signal);
      const observed = pending.then(() => { throw new Error('Cancelled LSP computation succeeded'); }, error => error);
      const cancelled = port.worker;
      if (!cancelled || cancelled.processId <= 0) throw new Error('LSP process did not start');
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      ctrl.abort(new Error('probe cancellation')); await observed; await port.close();
      if (!cancelled.reaped) throw new Error('Cancelled LSP process survived result settlement');
      cancelledPids.push(cancelled.processId);
    }
    return { ok: true, detectedCode: 2322, closedPid: first.processId, cancelledPids, physicalReaps: 9 };
  } catch (cause) { return { ok: false, error: String(cause.message ?? cause) }; }
  finally { await port?.close(); if (root) await rm(root, { recursive: true, force: true }); }
};
