
export type LspInstallProgress =
  | { phase: 'start'; serverId: string; version: string; targetDir: string }
  | { phase: 'log'; line: string }
  | { phase: 'done'; installDir: string }
  | { phase: 'error'; message: string };
