/**
 * Dev launcher — spawns Electron pointing at the Vite dev server.
 * Runs via `tsx`, no build step. The dashboard's Vite server should
 * already be running on :5173 (npm run dev:dashboard) when this fires.
 *
 * Production launch is handled by the electron-builder output; this
 * file is dev-only.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const nodeRequire = createRequire(import.meta.url);

// `electron` ships a CLI at the path returned by `require('electron')`.
// We spawn it directly so stdout/stderr stream through the parent.
const electronBin: string = nodeRequire('electron');

const child = spawn(electronBin, [path.join(__dirname, 'main.ts')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    MCP_ELECTRON_DEV_URL: process.env.MCP_ELECTRON_DEV_URL ?? 'http://localhost:5173',
    // tsx loader so the .ts files in apps/electron resolve at runtime.
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import tsx/esm`.trim(),
  },
});

child.on('exit', (code) => process.exit(code ?? 0));
