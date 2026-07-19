#!/usr/bin/env node
/**
 * Stream the GitHub App OAuth credentials from temporary files into Wrangler.
 * Values are never printed or passed as process arguments, and the temporary
 * files are removed only after both uploads succeed.
 *
 * Usage (from services/cloud-api):
 *   node scripts/set-github-app-oauth-secrets.mjs <client-secret-file> <client-id-file>
 */
import { spawn } from 'node:child_process';
import { readFile, realpath, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const [clientSecretPath, clientIdPath] = process.argv.slice(2);
if (![clientSecretPath, clientIdPath].every((value) => value && path.isAbsolute(value))) {
  console.error('Provide absolute paths for the temporary client-secret and client-id files.');
  process.exit(2);
}

async function assertTemporaryFile(filePath) {
  const resolved = await realpath(filePath);
  const relative = path.relative(await realpath(os.tmpdir()), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Credential file must be inside the operating-system temporary directory.');
  }
  return resolved;
}

async function putSecret(name, value) {
  const isWindows = process.platform === 'win32';
  const command = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'npx';
  const args = isWindows
    ? ['/d', '/s', '/c', `npx.cmd wrangler secret put ${name}`]
    : ['wrangler', 'secret', 'put', name];

  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: new URL('..', import.meta.url),
      stdio: ['pipe', 'inherit', 'inherit'],
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Wrangler exited with code ${code ?? 'unknown'} while setting ${name}.`));
    });
    child.stdin.end(value);
  });
}

const safeClientSecretPath = await assertTemporaryFile(clientSecretPath);
const safeClientIdPath = await assertTemporaryFile(clientIdPath);
const [clientSecret, clientId] = await Promise.all([
  readFile(safeClientSecretPath, 'utf8'),
  readFile(safeClientIdPath, 'utf8'),
]);

await putSecret('GITHUB_APP_CLIENT_SECRET', clientSecret);
await putSecret('GITHUB_APP_CLIENT_ID', clientId);
await Promise.all([unlink(safeClientSecretPath), unlink(safeClientIdPath)]);
console.log('Uploaded GitHub App OAuth secrets and removed their temporary files.');
