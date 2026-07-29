import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  VerifiedRuntimePackage,
} from '../../packages/agent-runtime-host/src/index.js';

export type SignaturePolicy = 'allow-unsigned' | 'required';

export interface SignatureReport {
  readonly policy: SignaturePolicy;
  readonly platform: NodeJS.Platform;
  readonly signed: boolean;
  readonly details: readonly string[];
}

export function verifyInstalledSignatures(
  appDirectory: string,
  verified: VerifiedRuntimePackage,
  policy: SignaturePolicy,
): SignatureReport {
  const report = process.platform === 'win32'
    ? verifyWindows(appDirectory, verified)
    : process.platform === 'darwin'
      ? verifyMacos(appDirectory, verified)
      : verifyLinux();
  return Object.freeze({ ...report, policy });
}

function verifyWindows(
  appDirectory: string,
  verified: VerifiedRuntimePackage,
): Omit<SignatureReport, 'policy'> {
  const paths = [
    join(appDirectory, 'CodeStudio.exe'),
    verified.binaries.hostBridge.absolutePath,
    verified.binaries.runner.absolutePath,
    verified.binaries.supervisor.absolutePath,
  ];
  const details: string[] = [];
  let signed = true;
  for (const path of paths) {
    const status = windowsSignatureStatus(path);
    details.push(`${path}:${status}`);
    signed &&= status === 'Valid';
  }
  return { platform: process.platform, signed, details };
}

function windowsSignatureStatus(path: string): string {
  const tool = windowsSignTool();
  if (!tool) return 'CheckUnavailable(signtool.exe not found)';
  const result = spawnSync(tool, ['verify', '/pa', '/all', '/v', path], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  if (result.status === 0) return 'Valid';
  const detail = (result.stderr || result.stdout)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) ?? 'verification failed';
  return `InvalidOrUnsigned(${detail.slice(0, 160)})`;
}

function windowsSignTool(): string | undefined {
  const kitsRoot = join(
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'Windows Kits',
    '10',
    'bin',
  );
  if (!existsSync(kitsRoot)) return undefined;
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  const versions = readdirSync(kitsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+(?:\.\d+)+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  return versions
    .map((version) => join(kitsRoot, version, architecture, 'signtool.exe'))
    .find(existsSync);
}

function verifyMacos(
  appDirectory: string,
  verified: VerifiedRuntimePackage,
): Omit<SignatureReport, 'policy'> {
  const paths = [
    appDirectory,
    verified.binaries.hostBridge.absolutePath,
    verified.binaries.runner.absolutePath,
    verified.binaries.supervisor.absolutePath,
  ];
  const details: string[] = [];
  let signed = true;
  for (const path of paths) {
    const verification = spawnSync(
      'codesign',
      ['--verify', '--strict', '--verbose=2', path],
      { encoding: 'utf8', shell: false },
    );
    const display = spawnSync(
      'codesign',
      ['--display', '--verbose=4', path],
      { encoding: 'utf8', shell: false },
    );
    const metadata = `${display.stdout}\n${display.stderr}`;
    const trustedIdentity = /(?:^|\n)Authority=.+/u.test(metadata)
      && !/(?:^|\n)Signature=adhoc/u.test(metadata);
    const valid = verification.status === 0
      && display.status === 0
      && trustedIdentity;
    details.push(`${path}:${valid ? 'Valid' : 'InvalidOrAdHoc'}`);
    signed &&= valid;
  }
  if (signed) {
    const assessment = spawnSync(
      'spctl',
      ['--assess', '--type', 'execute', '--verbose=2', appDirectory],
      { encoding: 'utf8', shell: false },
    );
    signed = assessment.status === 0;
    details.push(`gatekeeper:${signed ? 'Accepted' : 'Rejected'}`);
  }
  return { platform: process.platform, signed, details };
}

function verifyLinux(): Omit<SignatureReport, 'policy'> {
  return {
    platform: process.platform,
    signed: false,
    details: [
      'Linux detached release signature and trust root are not configured',
    ],
  };
}
