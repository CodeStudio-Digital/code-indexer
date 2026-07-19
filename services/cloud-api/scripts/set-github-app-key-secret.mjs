#!/usr/bin/env node
/**
 * Convert a GitHub-generated PEM (PKCS#1 or PKCS#8) to a private RSA JWK and
 * stream it directly into Wrangler's interactive secret command. The JWK is
 * never written to disk, printed, or passed as a process argument.
 *
 * Usage (from services/cloud-api):
 *   node scripts/set-github-app-key-secret.mjs C:\\secure\\app.private-key.pem
 */
import { createPrivateKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const pemPath = process.argv[2];
if (!pemPath || !path.isAbsolute(pemPath)) {
  console.error('Provide the absolute path to the GitHub App private-key PEM.');
  process.exit(2);
}

const pem = await readFile(pemPath);
const jwk = createPrivateKey(pem).export({ format: 'jwk' });
if (jwk.kty !== 'RSA' || !jwk.d) throw new Error('The supplied PEM is not an RSA private key.');

const isWindows = process.platform === 'win32';
const command = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'npx';
const args = isWindows
  ? ['/d', '/s', '/c', 'npx.cmd wrangler secret put GITHUB_APP_PRIVATE_KEY_JWK']
  : ['wrangler', 'secret', 'put', 'GITHUB_APP_PRIVATE_KEY_JWK'];
const child = spawn(command, args, {
  cwd: new URL('..', import.meta.url),
  stdio: ['pipe', 'inherit', 'inherit'],
  windowsHide: true,
});
child.stdin.end(JSON.stringify(jwk));
child.on('error', (error) => {
  console.error(`Could not start Wrangler: ${error.message}`);
  process.exitCode = 1;
});
child.on('close', (code) => {
  process.exitCode = code ?? 1;
});
