// A successful package build must contain the real script engine and its WASM.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url), electron = require('electron');
const code = `
  (async () => {
    const {runPreScript} = require('./dist/packages/services/src/api-client/script-runtime/index.js');
    const variables = {};
    const result = await runPreScript({source:'pm.environment.set("probe", "42");', variables,
      request:{method:'GET', url:'/', headers:{}, body:''}});
    if (result.error || variables.probe !== '42') throw new Error(result.error ?? 'Script engine returned an invalid value');
    console.log('Electron API script worker + QuickJS WASM smoke passed');
    const {convertWebContent} = require('./dist/packages/code-agent/src/tools/web/content-worker.js');
    if (await convertWebContent('html', '<h1>Web probe</h1>') !== '# Web probe') throw new Error('Web converter failed');
    console.log('Electron web content worker smoke passed');
  })().catch(error => { console.error(error); process.exitCode = 1; });
`;
const result = spawnSync(electron, ['-e', code], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8', windowsHide: true, timeout: 15000 });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
