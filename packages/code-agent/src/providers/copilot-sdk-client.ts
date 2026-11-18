import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CopilotClient } from '@microsoft/copilot-sdk';
export type { Model as CopilotModel } from '@microsoft/copilot-sdk';
import { mcpDataDir } from '@mcp/shared/utils/config.js';

function packagedRuntimePath(): string | undefined {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resources) return undefined;
  const platform = process.platform + '-' + process.arch;
  const executable = process.platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime';
  // Native processes need the physical file even when fs can read ASAR.
  const path = join(resources, 'app.asar.unpacked', 'node_modules', '@microsoft',
    'copilot-sdk-' + platform, 'prebuilds', platform, executable);
  return existsSync(path) ? path : undefined;
}

export async function startCopilotClient(providerId = 'copilot'): Promise<CopilotClient> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(providerId)) {
    throw new Error('Invalid GitHub Copilot provider ID');
  }
  const baseDirectory = join(mcpDataDir(), 'copilot', 'provider-' + providerId);
  await mkdir(baseDirectory, { recursive: true });
  const { CopilotClient, RuntimeConnection } = await import('@microsoft/copilot-sdk');
  const client = new CopilotClient({
    mode: 'empty',
    runtime: RuntimeConnection.forSpawnedStdio({
      path: packagedRuntimePath(), baseDirectory, workingDirectory: baseDirectory,
    }),
  });
  try {
    await client.start();
    return client;
  } catch (error) {
    await client.forceStop().catch(() => {});
    throw error;
  }
}

export async function stopCopilotClient(client: CopilotClient): Promise<void> {
  try {
    await client.stop();
  } catch {
    await client.forceStop().catch(() => {});
  }
}
