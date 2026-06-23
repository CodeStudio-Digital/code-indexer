/**
 * Custom editor for `.drawio` files in the project editor tab area — mounts
 * the shared DrawioFrame instead of Monaco. Reuses the IDE's content/dirty/
 * save machinery: editor edits flow through `setContent` (marks the tab
 * dirty), and a save (the editor's own Ctrl+S, or the IDE's when the iframe
 * isn't focused) persists via the shared `saveFile` helper — which reads the
 * store mirror since there's no Monaco model for this path.
 */
import { useCallback } from 'react';
import type { OpenFile } from '../../../state/workspace.js';
import { useWorkspaceStore } from '../../../state/workspace.js';
import { useEnsureFileContent } from './useEnsureFileContent.js';
import { saveFile } from './save.js';
import { DrawioFrame } from '../../chat/right-panel/diagram/DrawioFrame.js';

export function DrawioEditor({ file }: { file: OpenFile }) {
  // Hydrate the .drawio XML on first activation (tabs open with content: null).
  useEnsureFileContent(file);
  const setContent = useWorkspaceStore((s) => s.setContent);

  const onChange = useCallback(
    (xml: string) => setContent(file.projectId, file.path, xml),
    [setContent, file.projectId, file.path],
  );

  const onSave = useCallback(
    (xml: string) => {
      setContent(file.projectId, file.path, xml);
      void saveFile(file.projectId, file.path);
    },
    [setContent, file.path, file.projectId],
  );

  return (
    <div className="h-full min-h-0">
      <DrawioFrame xml={file.content} title={file.path} onChange={onChange} onSave={onSave} />
    </div>
  );
}
