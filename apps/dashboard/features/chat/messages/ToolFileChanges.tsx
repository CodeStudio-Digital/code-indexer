import { useEffect, useState } from 'react';
import { fetchToolSnapshots } from '../../snapshots/tool-api.js';
import type { ToolSnapshotFileSummary } from '../../snapshots/types.js';
import { useSnapshotActions } from './snapshot-files-context.js';
import type { EditFileRef } from './edit-tools.js';
import { FileChangeRow } from './FileChangeRow.js';

export function ToolFileChanges({ toolUseId, ready, files }: { toolUseId: string; ready: boolean; files: EditFileRef[] }) {
  const actions = useSnapshotActions();
  const sessionId = actions?.sessionId;
  const scope = actions?.scope;
  const [captured, setCaptured] = useState<{ key: string; files: ToolSnapshotFileSummary[] } | null>(null);
  const key = `${scope}:${sessionId}:${toolUseId}`;
  useEffect(() => {
    if (!ready || !sessionId || !scope) return;
    const controller = new AbortController();
    void fetchToolSnapshots(scope, sessionId, toolUseId, controller.signal)
      .then(result => { if (!controller.signal.aborted) setCaptured({ key, files: result.files }); })
      .catch(() => { if (!controller.signal.aborted) setCaptured(null); });
    return () => controller.abort();
  }, [ready, scope, sessionId, toolUseId, key]);
  const snapshots = ready && captured?.key === key ? captured.files : [];
  return snapshots.length > 0
    ? snapshots.map(snapshot => <FileChangeRow key={`${snapshot.toolUseId}:${snapshot.fileIndex}`}
      file={{ path: snapshot.filePath, op: !snapshot.existedAfter ? 'delete' : snapshot.existedBefore ? 'edit' : 'add' }}
      toolSnapshot={snapshot} />)
    : files.map(file => <FileChangeRow key={`${file.path}:${file.op}`} file={file} />);
}
