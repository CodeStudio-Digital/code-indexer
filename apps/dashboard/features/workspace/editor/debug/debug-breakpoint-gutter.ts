import type * as MonacoNs from 'monaco-editor';
import type { DebugSourceBreakpoint } from '@mcp/api-bus';

interface DebugBreakpointGutterItem extends DebugSourceBreakpoint {
  actualLine?: number;
  verified?: boolean;
  verificationMessage?: string;
}

interface DebugBreakpointGutterOptions {
  breakpoints: DebugBreakpointGutterItem[];
  onToggle(line: number): void;
  onMoved(breakpoints: DebugSourceBreakpoint[]): void;
}

function sameLines(left: DebugSourceBreakpoint[], right: DebugSourceBreakpoint[]): boolean {
  return left.length === right.length && left.every((breakpoint, index) => breakpoint.line === right[index]?.line);
}

export function attachDebugBreakpointGutter(
  editor: MonacoNs.editor.IStandaloneCodeEditor,
  monaco: typeof MonacoNs,
  options: DebugBreakpointGutterOptions,
): { dispose(): void } {
  const model = editor.getModel();
  if (!model) return { dispose() { /* no model */ } };

  let rendered = [...options.breakpoints].sort((a, b) => a.line - b.line);
  const collection = editor.createDecorationsCollection(rendered.map((breakpoint) => ({
    range: new monaco.Range(breakpoint.actualLine ?? breakpoint.line, 1, breakpoint.actualLine ?? breakpoint.line, 1),
    options: {
      glyphMarginClassName: breakpoint.verified === false
        ? 'mcp-debug-breakpoint-glyph mcp-debug-breakpoint-glyph-unverified'
        : 'mcp-debug-breakpoint-glyph',
      glyphMarginHoverMessage: {
        value: breakpoint.verified === false
          ? (breakpoint.verificationMessage ?? `Breakpoint da linha ${breakpoint.line} ainda não foi confirmado`)
          : `Remover breakpoint da linha ${breakpoint.line} (Ctrl+F8)`,
      },
      glyphMargin: { position: monaco.editor.GlyphMarginLane.Center },
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  })));

  const toggleAt = (line: number | undefined): void => {
    if (line == null || line < 1 || line > model.getLineCount()) return;
    const existing = rendered.find((breakpoint) => (breakpoint.actualLine ?? breakpoint.line) === line);
    options.onToggle(existing?.line ?? line);
  };

  const mouse = editor.onMouseDown((event) => {
    if (!event.event.leftButton) return;
    if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const lane = event.target.detail.glyphMarginLane;
    if (lane != null && lane !== monaco.editor.GlyphMarginLane.Center) return;
    toggleAt(event.target.position?.lineNumber);
  });

  const action = editor.addAction({
    id: 'mcp.debug.toggleBreakpoint',
    label: 'Toggle Breakpoint',
    contextMenuGroupId: 'debug',
    contextMenuOrder: 1,
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.F8],
    run: () => toggleAt(editor.getPosition()?.lineNumber),
  });

  let moveTimer: ReturnType<typeof setTimeout> | null = null;
  const content = model.onDidChangeContent(() => {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      const ranges = collection.getRanges();
      const moved = rendered.map((breakpoint, index) => ({
        ...breakpoint,
        line: ranges[index]?.startLineNumber ?? breakpoint.line,
        actualLine: undefined,
        verified: undefined,
        verificationMessage: undefined,
      })).sort((a, b) => a.line - b.line);
      if (sameLines(rendered, moved)) return;
      rendered = moved;
      options.onMoved(moved);
    }, 0);
  });

  return {
    dispose() {
      if (moveTimer) clearTimeout(moveTimer);
      collection.clear();
      mouse.dispose();
      action.dispose();
      content.dispose();
    },
  };
}
