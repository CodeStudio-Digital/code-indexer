import { app } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const APP_IDENTITY = {
  displayName: 'CodeStudio',
  // Must match electron-builder's appId and the installer shortcuts so pinned
  // launchers, running windows and notifications share one Windows identity.
  userModelId: 'studio.codestudio.app',
} as const;

export function resolveAppIconPath(): string | undefined {
  const electronRoot = path.resolve(__dirname, '..');
  const candidates = [
    app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : undefined,
    path.join(electronRoot, 'build', 'icon.png'),
    path.join(electronRoot, 'icon.png'),
    path.resolve(__dirname, '../../../../apps/electron/build/icon.png'),
  ].filter((candidate): candidate is string => !!candidate);

  return candidates.find((candidate) => existsSync(candidate));
}
