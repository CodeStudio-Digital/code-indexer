import { isAbsolute, relative } from 'node:path';
import { LocalFilesystemAdapter } from '@mcp/code-agent/ports/filesystem-port.js';
import { SnapshotRecordingFilesystemPort } from '@mcp/code-agent/ports/snapshot-recording-filesystem-port.js';
import type { IFilesystemPort } from '@mcp/code-agent/ports/filesystem-port.js';
import type { NativeHostBridgeBinding } from '../../../packages/agent-runtime-host/src/native/NativeHostBridgeBinding.js';

/** Installed before execution, retaining the preparation's snapshot recorder. */
export function nativeFilesystemPort(input: {
  prepared: IFilesystemPort | undefined;
  root: string;
  rename: NonNullable<NativeHostBridgeBinding['renameNativePathNoReplace']>;
  assertCurrent(): void;
}): IFilesystemPort {
  if (!(input.prepared instanceof SnapshotRecordingFilesystemPort)) {
    throw new Error('Native filesystem requires its prepared snapshot owner');
  }
  const local = new LocalFilesystemAdapter((source, destination) => {
    const from = relative(input.root, source), to = relative(input.root, destination);
    for (const value of [from, to]) {
      if (!value || isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
        throw new Error('Native move must stay within the attempt workspace');
      }
    }
    // No await between revalidating the workspace owner and dispatching the
    // kernel rename. The primitive itself opens and pins both parent chains.
    input.assertCurrent();
    input.rename(input.root, from, to);
  });
  return input.prepared.withPhysicalPort(local);
}
