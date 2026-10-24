// Compare an extracted installer with the exact package exercised by the harness.
// Extraction is separate; this verifier never executes the installer.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const [installerArg, extractedArg, packageArg, reportArg] = process.argv.slice(2);
if (!installerArg || !extractedArg || !packageArg || !reportArg) {
  throw new Error('Usage: <installer.exe> <extracted-directory> <tested-package-directory> <report.json>');
}
const installer = resolve(installerArg), extracted = resolve(extractedArg), tested = resolve(packageArg);
async function files(root) {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  assert(!entries.some(entry => entry.isSymbolicLink()), 'Payload contains a symbolic link');
  return entries.filter(entry => entry.isFile()).map(entry => relative(root, join(entry.parentPath, entry.name))).sort();
}
async function hash(path) {
  const digest = createHash('sha256');
  for await (const data of createReadStream(path)) digest.update(data);
  return digest.digest('hex');
}
const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), installer,
  installerBytes: (await stat(installer)).size, installerSha256: await hash(installer),
  scope: 'Every extracted regular file compared with the tested package; installer not executed', files: [], passed: false };
try {
  const payloadFiles = await files(extracted), packageFiles = await files(tested);
  assert.deepEqual(payloadFiles, packageFiles, 'Extracted and tested file inventories differ');
  for (const path of payloadFiles) {
    const [extractedSha256, packagedSha256] = await Promise.all([hash(join(extracted, path)), hash(join(tested, path))]);
    report.files.push({ path, sha256: extractedSha256, packagedSha256 });
    assert.equal(extractedSha256, packagedSha256, `Installer differs from tested package: ${path}`);
  }
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await writeFile(resolve(reportArg), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, files: report.files.length,
    installerSha256: report.installerSha256, failure: report.failure }));
}
