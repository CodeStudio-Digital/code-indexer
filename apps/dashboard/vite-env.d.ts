import type { ElectronAPI as DesktopElectronAPI } from '@mcp/api-bus/electron-bridge.js';

declare global {
  const __APP_VERSION__: string;
  type ElectronAPI = DesktopElectronAPI;
}

export {};
