import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { verifyBuild } from './release/verify.mjs';
const [candidate, destination] = process.argv.slice(2);
if (!candidate || !destination) throw new Error('Usage: verify-harness-package.mjs <package-directory> <fresh-report-directory>');
const output = resolve(destination);
await mkdir(output); // Evidence must never overwrite an earlier run.
const smoke = verifyBuild(process.cwd(), resolve(candidate));
await writeFile(join(output, 'smoke.json'), JSON.stringify(smoke, null, 2));
let failed = !smoke.ok;
for (const [name, flags] of [['legacy', ['--legacy-worktree']], ['direct-rag', ['--native', '--rag']]]) {
  const result = spawnSync(process.execPath, ['scripts/harness-electron-admission.mjs', join(output, name),
    join(resolve(candidate), 'win-unpacked/CodeStudio.exe'), '--existing-project', ...flags], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  failed ||= result.status !== 0;
}
process.exitCode = failed ? 1 : 0;
