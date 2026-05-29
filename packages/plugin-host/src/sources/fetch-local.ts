import { cp, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { MaterializeResult } from './index.js';

/** Copy a local plugin directory into staging (does not mutate the source). */
export async function materializeLocal(
  rootPath: string,
  stagingDir: string,
): Promise<MaterializeResult> {
  try {
    await access(join(rootPath, 'plugin.json'));
  } catch {
    throw new Error(`No plugin.json in local source "${rootPath}"`);
  }
  await cp(rootPath, stagingDir, { recursive: true });
  return { ref: null };
}
