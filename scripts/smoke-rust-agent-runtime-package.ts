import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  parseRuntimePackageAnchor,
  verifyRuntimePackage,
} from '../packages/agent-runtime-host/src/index.js';
import {
  probeInstalledBinary,
} from './rust-agent-installed-smoke/process-probe.js';
import {
  withReadOnlyPackage,
} from './rust-agent-installed-smoke/read-only-package.js';
import {
  smokeNativeHostBridge,
} from './rust-agent-installed-smoke/native-addon.js';

const root = resolve(import.meta.dirname, '..');
const anchor = parseRuntimePackageAnchor(
  await readFile(resolve(
    root,
    'dist/apps/electron/native-agent-runtime-integrity.json',
  )),
);
const packageDirectory = resolve(
  root,
  'dist/native-agent-runtime',
  anchor.targetTriple,
);
const verified = await verifyRuntimePackage(packageDirectory, anchor);

await withReadOnlyPackage(
  packageDirectory,
  anchor,
  resolve(root, '.tmp'),
  async (readOnlyPackage) => {
    await smokeNativeHostBridge(readOnlyPackage, anchor);
    const suffix = process.platform === 'win32' ? '.exe' : '';
    await probeInstalledBinary(
      resolve(readOnlyPackage, `agent-runner${suffix}`),
      'runner',
    );
    await probeInstalledBinary(
      resolve(readOnlyPackage, `agentd-supervisor${suffix}`),
      'supervisor',
    );
  },
);

process.stdout.write(
  `RUST_AGENT_PACKAGE_SMOKE_OK target=${verified.manifest.targetTriple}`
  + ` build=${verified.manifest.buildId}`
  + ' readOnly=true addonLoad=hostBridge launchKill=runner,supervisor\n',
);
