/**
 * Barrel for coder tool-execution ports.
 *
 * These ports let the same tool code run against either the host
 * filesystem/shell (default, unchanged behavior) or a remote sandbox
 * (builder mode) — chosen by what the enclosing session injects into
 * `ToolContext.ports`.
 */

export type {
  IFilesystemPort,
  PortDirent,
  FilesystemReaddirOptions,
} from '@mcp/code-agent/ports/filesystem-port.js';
export { LocalFilesystemAdapter, defaultLocalFilesystemPort } from '@mcp/code-agent/ports/filesystem-port.js';

export type {
  IShellPort,
  ShellExecResult,
  ShellExecOptions,
  ShellRunOptions,
} from '@mcp/code-agent/ports/shell-port.js';
export { LocalShellAdapter, defaultLocalShellPort } from '@mcp/code-agent/ports/shell-port.js';

export {
  SnapshotRecorder,
  SnapshotRecordingFilesystemPort,
} from '@mcp/code-agent/ports/snapshot-recording-filesystem-port.js';
export type { SnapshotRecorderDeps } from '@mcp/code-agent/ports/snapshot-recording-filesystem-port.js';
