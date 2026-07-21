import { useEffect } from 'react';
import type * as MonacoNs from 'monaco-editor';
import type { OpenFile } from '../../../../state/workspace.js';
import { apiCall } from '../../../../lib/api-client.js';
import { toast } from '../../../../components/ui/prompt-dialog.js';
import {
  isJavaScriptDebugPath,
  replaceDebugBreakpoints,
  selectDebugBreakpoints,
  toggleDebugBreakpoint,
  useDebugBreakpoints,
} from '../../../../state/debug-breakpoints.js';
import { activeDebugSessionForProject, useDebugSessions } from '../../../../state/debug-sessions.js';
import { attachDebugBreakpointGutter } from './debug-breakpoint-gutter.js';

export function useDebugBreakpointGutter(
  file: OpenFile,
  editor: MonacoNs.editor.IStandaloneCodeEditor | null,
  monaco: typeof MonacoNs | null,
): void {
  const breakpoints = useDebugBreakpoints((state) => selectDebugBreakpoints(state, file.projectId, file.path));
  const session = useDebugSessions((state) => activeDebugSessionForProject(state.sessions, file.projectId));
  const eligible = (!file.kind || file.kind === 'file') && isJavaScriptDebugPath(file.path);

  useEffect(() => {
    if (!editor || !monaco || file.content === null || !eligible) return;
    const handle = attachDebugBreakpointGutter(editor, monaco, {
      breakpoints,
      onToggle: (line) => { toggleDebugBreakpoint(file.projectId, file.path, line); },
      onMoved: (moved) => { replaceDebugBreakpoints(file.projectId, file.path, moved); },
    });
    return () => handle.dispose();
  }, [breakpoints, editor, eligible, file.content, file.path, file.projectId, monaco]);

  useEffect(() => {
    if (!eligible || !session || !['running', 'paused'].includes(session.state)) return;
    let active = true;
    void apiCall('debug.setBreakpoints', {
      sessionId: session.sessionId,
      source: { path: file.path, breakpoints },
    }).catch((error) => {
      if (!active) return;
      toast.error('Não foi possível sincronizar os breakpoints', {
        description: error instanceof Error ? error.message : String(error),
      });
    });
    return () => { active = false; };
  }, [breakpoints, eligible, file.path, session?.sessionId, session?.state]);
}
