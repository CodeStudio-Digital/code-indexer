import { useEffect } from 'react';
import type * as MonacoNs from 'monaco-editor';
import type { DebugBreakpoint } from '@mcp/api-bus';
import type { OpenFile } from '../../../../state/workspace.js';
import { apiCall } from '../../../../lib/api-client.js';
import { toast } from '../../../../components/ui/prompt-dialog.js';
import {
  isJavaScriptDebugPath,
  replaceDebugBreakpoints,
  selectDebugBreakpointRuntime,
  selectDebugBreakpoints,
  setDebugBreakpointRuntime,
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
  const session = useDebugSessions((state) => activeDebugSessionForProject(state.sessions, file.projectId));
  const breakpoints = useDebugBreakpoints((state) => selectDebugBreakpoints(state, file.projectId, file.path));
  const runtime = useDebugBreakpoints((state) => selectDebugBreakpointRuntime(
    state,
    file.projectId,
    file.path,
    session?.sessionId,
  ));
  const sessionBreakpointRevision = (session?.breakpoints ?? []).map((breakpoint) => [
    breakpoint.id ?? '',
    breakpoint.path,
    breakpoint.requestedLine,
    breakpoint.verified ? 1 : 0,
    breakpoint.line ?? '',
    breakpoint.message ?? '',
  ].join(':')).join('|');
  const eligible = (!file.kind || file.kind === 'file') && isJavaScriptDebugPath(file.path);

  useEffect(() => {
    if (!editor || !monaco || file.content === null || !eligible) return;
    const gutterBreakpoints = breakpoints.map((breakpoint) => {
      const status = runtime.find((candidate) => candidate.requestedLine === breakpoint.line);
      return {
        ...breakpoint,
        actualLine: status?.line,
        verified: status?.verified,
        verificationMessage: status?.message,
      };
    });
    const handle = attachDebugBreakpointGutter(editor, monaco, {
      breakpoints: gutterBreakpoints,
      onToggle: (line) => { toggleDebugBreakpoint(file.projectId, file.path, line); },
      onMoved: (moved) => { replaceDebugBreakpoints(file.projectId, file.path, moved); },
    });
    return () => handle.dispose();
  }, [breakpoints, editor, eligible, file.content, file.path, file.projectId, monaco, runtime]);

  useEffect(() => {
    if (!eligible || !session || !['running', 'paused'].includes(session.state)) return;
    let active = true;
    void apiCall<DebugBreakpoint[]>('debug.setBreakpoints', {
      sessionId: session.sessionId,
      source: { path: file.path, breakpoints },
    }).then((resolved) => {
      if (active) setDebugBreakpointRuntime(file.projectId, file.path, session.sessionId, breakpoints, resolved);
    }).catch((error) => {
      if (!active) return;
      toast.error('Não foi possível sincronizar os breakpoints', {
        description: error instanceof Error ? error.message : String(error),
      });
    });
    return () => { active = false; };
  }, [breakpoints, eligible, file.path, session?.sessionId, session?.state]);

  useEffect(() => {
    if (!eligible || !session) return;
    const fileKey = file.path.replace(/\\/g, '/');
    const live = (session.breakpoints ?? []).filter((breakpoint) => breakpoint.path.replace(/\\/g, '/') === fileKey);
    if (live.length === 0) return;
    const resolved = breakpoints.map((breakpoint): DebugBreakpoint => {
      const current = live.find((candidate) => candidate.requestedLine === breakpoint.line);
      return current ?? { verified: false, line: breakpoint.line };
    });
    setDebugBreakpointRuntime(file.projectId, file.path, session.sessionId, breakpoints, resolved);
  }, [breakpoints, eligible, file.path, file.projectId, session?.sessionId, sessionBreakpointRevision]);
}
