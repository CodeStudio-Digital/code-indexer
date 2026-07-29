import { resolve } from 'node:path';
import {
  parseRuntimePackageAnchor,
} from '../packages/agent-runtime-host/src/index.js';
import {
  readInstalledRuntimeAnchor,
} from './rust-agent-installed-smoke/asar-anchor.js';
import {
  scanInstalledRuntime,
} from './rust-agent-installed-smoke/antivirus.js';
import {
  verifyInstalledAsarFuses,
} from './rust-agent-installed-smoke/electron-fuses.js';
import {
  inspectInstalledRuntime,
} from './rust-agent-installed-smoke/layout.js';
import {
  probeInstalledBinary,
} from './rust-agent-installed-smoke/process-probe.js';
import {
  withReadOnlyPackage,
} from './rust-agent-installed-smoke/read-only-package.js';
import {
  smokeNativeHostBridge,
} from './rust-agent-installed-smoke/native-addon.js';
import {
  verifyInstalledSignatures,
  type SignaturePolicy,
} from './rust-agent-installed-smoke/signature.js';

const root = resolve(import.meta.dirname, '..');
const appDirectory = resolve(requiredArgument('--app-dir'));
const policy = signaturePolicy(argument('--signature-policy') ?? 'required');
const layout = await inspectInstalledRuntime(appDirectory);
await verifyInstalledAsarFuses(layout.appDirectory);
const signature = verifyInstalledSignatures(
  layout.appDirectory,
  layout.verified,
  policy,
);
const antivirus = scanInstalledRuntime(layout.packageDirectory, policy);
if (policy === 'required' && (!signature.signed || !antivirus.clean)) {
  const failures = [
    ...(!signature.signed ? signature.details : []),
    ...(!antivirus.clean ? [antivirus.detail] : []),
  ];
  throw new Error(`installed release security gate failed: ${failures.join('; ')}`);
}
if (!antivirus.clean) {
  process.stderr.write(`antivirus development bypass: ${antivirus.detail}\n`);
}
const anchor = parseRuntimePackageAnchor(
  await readInstalledRuntimeAnchor(layout.archivePath),
);

await withReadOnlyPackage(
  layout.packageDirectory,
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

process.stdout.write([
  'INSTALLED_RUST_AGENT_SMOKE_OK',
  `target=${layout.verified.manifest.targetTriple}`,
  `build=${layout.verified.manifest.buildId}`,
  `signature=${signature.signed ? 'valid' : 'allowed-unsigned'}`,
  `antivirus=${antivirus.clean ? 'clean' : 'not-required'}`,
  'asarIntegrity=true',
  'readOnly=true',
  'addonLoad=hostBridge',
  'launchKill=runner,supervisor',
  '\n',
].join(' '));

function argument(name: string): string | undefined {
  const equals = `${name}=`;
  const inline = process.argv.find((value) => value.startsWith(equals));
  if (inline) return inline.slice(equals.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArgument(name: string): string {
  const value = argument(name);
  if (!value) throw new TypeError(`missing required argument: ${name}`);
  return value;
}

function signaturePolicy(value: string): SignaturePolicy {
  if (value === 'allow-unsigned' || value === 'required') return value;
  throw new TypeError(`invalid signature policy: ${value}`);
}
