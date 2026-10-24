import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { nativeRuntimePaths } from '../native-runtime-paths.js';

it('loads packaged binaries beside the ASAR without Electron globals', () => {
  const resources = resolve('fixture/Code Studio/resources');
  expect(nativeRuntimePaths(join(resources, 'app.asar', 'dist'))).toEqual({
    packageDirectory: join(resources, 'native-agent-runtime/x86_64-pc-windows-msvc'),
    anchorPath: join(resources, 'app.asar/dist/apps/electron/native-agent-runtime-integrity.json'),
  });
});
it.each(['checkout/dist', 'checkout/app.asar-name/dist', 'app.asar/checkouts/dist'])('keeps %s inside its checkout', path => {
  const distRoot = resolve(path);
  expect(nativeRuntimePaths(distRoot).packageDirectory).toBe(join(distRoot, 'native-agent-runtime/x86_64-pc-windows-msvc'));
});
