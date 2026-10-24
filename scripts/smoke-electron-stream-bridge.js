/**
 * Process-real smoke for the packaged preload stream contract.
 *
 * Runs a hidden Electron renderer with the production preload bundle, sends a
 * runner.events snapshot over a real transferred MessagePort, and verifies
 * that contextBridge exposes the serializable next/return iterator intact.
 * Run after the preload build:
 *   electron scripts/smoke-electron-stream-bridge.js
 */
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { app, BrowserWindow, ipcMain, MessageChannelMain } from 'electron';

const root = process.cwd();
const preload = path.join(root, 'dist', 'apps', 'electron', 'preload.cjs');
const expectedTaskId = 'packaged-stream-smoke';
const resultPath = process.env.MCP_STREAM_SMOKE_RESULT;

ipcMain.on('security:getRendererCspNonce', (event) => {
  event.returnValue = 'stream-smoke-nonce';
});

ipcMain.on('stream:api:runner:events', (event, message) => {
  const { port1, port2 } = new MessageChannelMain();
  event.sender.postMessage(`stream-port:${message.requestId}`, null, [port1]);
  port2.start();
  port2.postMessage({
    type: 'value',
    value: [{ taskId: expectedTaskId, projectId: 1, status: 'running' }],
  });
});

await app.whenReady();

const win = new BrowserWindow({
  show: false,
  webPreferences: {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
  },
});

let exitCode = 0;
try {
  await win.loadURL('data:text/html,<title>stream-bridge-smoke</title>');
  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const iterator = window.electronAPI.openStream('runner.events', {});
      const first = await Promise.race([
        iterator.next(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('stream timeout')), 5000)),
      ]);
      return {
        ownKeys: Reflect.ownKeys(iterator).map((key) => String(key)),
        first,
      };
    })()
  `);

  if (
    JSON.stringify(result.ownKeys) !== JSON.stringify(['next', 'return'])
    || result.first?.done !== false
    || result.first?.value?.[0]?.taskId !== expectedTaskId
  ) {
    throw new Error(`unexpected stream bridge result: ${JSON.stringify(result)}`);
  }
  if (resultPath) writeFileSync(resultPath, JSON.stringify({ ok: true, ...result }), 'utf8');
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  exitCode = 1;
  if (resultPath) {
    writeFileSync(resultPath, JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.stack : String(error),
    }), 'utf8');
  }
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
} finally {
  win.destroy();
  app.exit(exitCode);
}
