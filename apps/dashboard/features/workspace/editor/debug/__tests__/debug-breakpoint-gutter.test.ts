import { describe, expect, it, vi } from 'vitest';
import { attachDebugBreakpointGutter } from '../debug-breakpoint-gutter.js';

describe('attachDebugBreakpointGutter', () => {
  it('owns the center lane, supports Ctrl+F8 and tracks line movement', () => {
    vi.useFakeTimers();
    let mouseListener: ((event: any) => void) | undefined;
    let contentListener: (() => void) | undefined;
    let actionConfig: { run(): void } | undefined;
    let ranges = [{ startLineNumber: 4 }];
    const collection = { getRanges: () => ranges, clear: vi.fn() };
    const mouseDispose = vi.fn();
    const contentDispose = vi.fn();
    const actionDispose = vi.fn();
    const model = {
      getLineCount: () => 40,
      onDidChangeContent: (listener: () => void) => {
        contentListener = listener;
        return { dispose: contentDispose };
      },
    };
    const editor = {
      getModel: () => model,
      getPosition: () => ({ lineNumber: 12 }),
      createDecorationsCollection: vi.fn(() => collection),
      onMouseDown: (listener: (event: any) => void) => {
        mouseListener = listener;
        return { dispose: mouseDispose };
      },
      addAction: (config: { run(): void }) => {
        actionConfig = config;
        return { dispose: actionDispose };
      },
    };
    class Range {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number,
      ) {}
    }
    const monaco = {
      Range,
      KeyMod: { CtrlCmd: 1 << 11 },
      KeyCode: { F8: 59 },
      editor: {
        GlyphMarginLane: { Left: 1, Center: 2, Right: 3 },
        MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
        TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 },
      },
    };
    const onToggle = vi.fn();
    const onMoved = vi.fn();
    const handle = attachDebugBreakpointGutter(editor as never, monaco as never, {
      breakpoints: [{ line: 4 }],
      onToggle,
      onMoved,
    });

    const event = (lane: number) => ({
      event: { leftButton: true },
      target: { type: 2, detail: { glyphMarginLane: lane }, position: { lineNumber: 8 } },
    });
    mouseListener?.(event(1));
    expect(onToggle).not.toHaveBeenCalled();
    mouseListener?.(event(2));
    expect(onToggle).toHaveBeenCalledWith(8);
    actionConfig?.run();
    expect(onToggle).toHaveBeenLastCalledWith(12);

    ranges = [{ startLineNumber: 6 }];
    contentListener?.();
    vi.runOnlyPendingTimers();
    expect(onMoved).toHaveBeenCalledWith([{ line: 6 }]);

    handle.dispose();
    expect(collection.clear).toHaveBeenCalled();
    expect(mouseDispose).toHaveBeenCalled();
    expect(contentDispose).toHaveBeenCalled();
    expect(actionDispose).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
