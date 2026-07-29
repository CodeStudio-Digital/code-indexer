import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type {
  RuntimePackageAnchor,
} from '../../packages/agent-runtime-host/src/index.js';

const CHILD = fileURLToPath(
  new URL('./native-addon-child.ts', import.meta.url),
);
const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export async function smokeNativeHostBridge(
  packageDirectory: string,
  anchor: RuntimePackageAnchor,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = fork(
      CHILD,
      [packageDirectory, JSON.stringify(anchor)],
      {
        execArgv: process.execArgv,
        silent: true,
        windowsHide: true,
      },
    );
    let output = '';
    let settled = false;
    const collect = (chunk: Buffer): void => {
      if (Buffer.byteLength(output) >= MAX_OUTPUT_BYTES) return;
      output += chunk.toString('utf8');
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => {
      child.kill();
      settle(new Error('native Host bridge child smoke timed out'));
    }, TIMEOUT_MS);
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.once('error', (error) => settle(error));
    child.once('exit', (code, signal) => {
      if (
        code === 0
        && signal === null
        && output.includes('NATIVE_HOST_BRIDGE_SMOKE_OK')
      ) {
        settle();
        return;
      }
      settle(new Error(
        `native Host bridge child smoke failed code=${String(code)}`
        + ` signal=${String(signal)} output=${output.slice(0, 2000)}`,
      ));
    });
  });
}
