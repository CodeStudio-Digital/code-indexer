/** Windows backend options for node-pty when it runs inside Electron. */
interface WindowsPtyBackendOptions {
  useConpty?: boolean;
  useConptyDll?: boolean;
}

/**
 * Use node-pty's bundled ConPTY/OpenConsole implementation in Electron.
 *
 * WinPTY can block synchronously after another PTY is already active in a
 * packaged app: winpty-agent.exe starts, but never creates the requested
 * shell, leaving the main-process RPC unresolved. The system-ConPTY path has
 * a different Electron problem during teardown because node-pty forks a
 * console-list helper through the GUI-subsystem Electron executable.
 *
 * The bundled ConPTY DLL avoids both paths: it supports concurrent terminals
 * and performs teardown without the console-list helper. Node and non-Windows
 * hosts retain node-pty's native defaults.
 */
export function electronWindowsPtyOptions(
  platform: NodeJS.Platform = process.platform,
  electronVersion: string | undefined = process.versions.electron,
): WindowsPtyBackendOptions {
  return platform === 'win32' && electronVersion
    ? { useConpty: true, useConptyDll: true }
    : {};
}
