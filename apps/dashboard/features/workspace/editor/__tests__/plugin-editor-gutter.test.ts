import { describe, expect, it, vi } from 'vitest';
import type { ContribEditorAction } from '../../../../state/contribution-registry.js';
import {
  attachPluginEditorGutter,
  collectPluginGutterMarkers,
  matchesEditorDocument,
  pluginEditorContextFromEditor,
} from '../plugin-editor-gutter.js';
import { choosePluginGutterMarker } from '../plugin-editor-action-runner.js';

function action(overrides: Partial<ContribEditorAction> = {}): ContribEditorAction {
  return {
    pluginNs: 'podman',
    id: 'build',
    label: 'Build image',
    runsTool: 'podman_project_run',
    documentSelector: { filePatterns: ['Dockerfile', 'Containerfile*'], languageIds: ['dockerfile'] },
    gutter: {
      line: { text: 'FROM', match: 'word', trim: true, caseSensitive: false },
      occurrence: 'first',
      icon: 'build',
    },
    ...overrides,
  };
}

describe('plugin editor gutter matching', () => {
  it('requires every configured document selector dimension', () => {
    const build = action();
    expect(matchesEditorDocument(build, 'containers/Containerfile.dev', 'dockerfile')).toBe(true);
    expect(matchesEditorDocument(build, 'containers/Containerfile.dev', 'plaintext')).toBe(false);
    expect(matchesEditorDocument(build, 'src/index.ts', 'dockerfile')).toBe(false);
  });

  it('matches a leading globstar at both the project root and nested paths', () => {
    const build = action({ documentSelector: { filePatterns: ['**/Dockerfile'], languageIds: ['dockerfile'] } });
    expect(matchesEditorDocument(build, 'Dockerfile', 'dockerfile')).toBe(true);
    expect(matchesEditorDocument(build, 'containers/runtime/Dockerfile', 'dockerfile')).toBe(true);
  });

  it('places a first-only marker on a case-insensitive Docker FROM instruction', () => {
    const markers = collectPluginGutterMarkers(
      'Dockerfile',
      'dockerfile',
      ['# syntax=docker/dockerfile:1', '  from node:22 AS build', 'FROM node:22-slim'],
      [action()],
    );
    expect([...markers.keys()]).toEqual([2]);
    expect(markers.get(2)?.[0].context).toMatchObject({ lineNumber: 2, column: 3 });
  });

  it('supports all occurrences and aggregates actions sharing a line', () => {
    const all = action({ gutter: { line: { text: 'FROM', match: 'word' }, occurrence: 'all' } });
    const inspect = action({ id: 'inspect', label: 'Inspect', gutter: {
      line: { text: 'FROM', match: 'word' }, occurrence: 'first', icon: 'inspect',
    } });
    const markers = collectPluginGutterMarkers('Dockerfile', 'dockerfile', ['FROM base', 'FROM final'], [all, inspect]);
    expect(markers.get(1)?.map((marker) => marker.action.id)).toEqual(['build', 'inspect']);
    expect(markers.get(2)?.map((marker) => marker.action.id)).toEqual(['build']);
  });
});

describe('attachPluginEditorGutter', () => {
  it('refreshes the concrete model, routes only the left lane, and disposes listeners', () => {
    vi.useFakeTimers();
    let lines = ['services:', '  api:'];
    let contentListener: (() => void) | undefined;
    let mouseListener: ((event: any) => void) | undefined;
    const contentDispose = vi.fn();
    const mouseDispose = vi.fn();
    const modelDispose = vi.fn();
    const collection = { set: vi.fn(), clear: vi.fn() };
    const model = {
      uri: { path: '/p7/docker-compose.yml' },
      getLanguageId: () => 'yaml',
      getLineCount: () => lines.length,
      getLineContent: (line: number) => lines[line - 1],
      onDidChangeContent: (listener: () => void) => {
        contentListener = listener;
        return { dispose: contentDispose };
      },
    };
    const editor = {
      getModel: () => model,
      createDecorationsCollection: () => collection,
      onDidChangeModel: () => ({ dispose: modelDispose }),
      onMouseDown: (listener: (event: any) => void) => {
        mouseListener = listener;
        return { dispose: mouseDispose };
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
      editor: {
        GlyphMarginLane: { Left: 1, Center: 2, Right: 3 },
        MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
        TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 },
      },
    };
    const compose = action({
      id: 'compose-up',
      label: 'Compose up',
      runsTool: 'podman_compose',
      documentSelector: { filePatterns: ['docker-compose.yml'], languageIds: ['yaml'] },
      gutter: { line: { text: 'services:', match: 'startsWith', trim: true }, occurrence: 'first' },
    });
    const invoke = vi.fn();
    const handle = attachPluginEditorGutter(
      editor as never,
      monaco as never,
      { projectId: 7, path: 'docker-compose.yml', content: lines.join('\n') } as never,
      [compose],
      invoke,
    );

    expect(collection.set).toHaveBeenCalledTimes(1);
    const event = (lane: number) => ({
      event: { leftButton: true, preventDefault: vi.fn(), stopPropagation: vi.fn() },
      target: { type: 2, detail: { glyphMarginLane: lane }, position: { lineNumber: 1 } },
    });
    mouseListener?.(event(2));
    expect(invoke).not.toHaveBeenCalled();
    mouseListener?.(event(1));
    expect(invoke).toHaveBeenCalledWith([
      expect.objectContaining({
        action: expect.objectContaining({ id: 'compose-up' }),
        context: expect.objectContaining({ path: 'docker-compose.yml', lineNumber: 1 }),
      }),
    ]);

    lines = ['name: demo', 'services:'];
    contentListener?.();
    expect(collection.set).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300);
    expect(collection.set).toHaveBeenCalledTimes(2);

    contentListener?.();
    handle.dispose();
    vi.runOnlyPendingTimers();
    expect(contentDispose).toHaveBeenCalled();
    expect(modelDispose).toHaveBeenCalled();
    expect(mouseDispose).toHaveBeenCalled();
    expect(collection.clear).toHaveBeenCalled();
    expect(collection.set).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('plugin editor action context and selection', () => {
  it('derives a split-safe context from the matching focused model', () => {
    const model = {
      uri: { path: '/p7/src/example.ts' },
      isDisposed: () => false,
      getLanguageId: () => 'typescript',
      getLineCount: () => 2,
      getLineMaxColumn: (line: number) => (line === 2 ? 14 : 6),
      getLineContent: (line: number) => (line === 2 ? 'const value = 1' : 'first'),
    };
    const editor = {
      getModel: () => model,
      getPosition: () => ({ lineNumber: 2, column: 7 }),
    };

    expect(pluginEditorContextFromEditor(editor as never, 7, 'src/example.ts', 'typescript')).toEqual({
      path: 'src/example.ts',
      languageId: 'typescript',
      lineNumber: 2,
      column: 7,
      lineText: 'const value = 1',
    });
  });

  it('falls back to the active document instead of borrowing another project model', () => {
    const editor = {
      getModel: () => ({
        uri: { path: '/p8/other.ts' },
        isDisposed: () => false,
      }),
    };

    expect(pluginEditorContextFromEditor(editor as never, 7, 'Dockerfile', 'dockerfile')).toEqual({
      path: 'Dockerfile',
      languageId: 'dockerfile',
      lineNumber: 1,
      column: 1,
      lineText: '',
    });
  });

  it('requires an explicit choice when actions share a gutter line', async () => {
    const context = { path: 'Dockerfile', languageId: 'dockerfile', lineNumber: 1, column: 1, lineText: 'FROM base' };
    const markers = [
      { action: action({ id: 'build' }), context },
      { action: action({ id: 'inspect', label: 'Inspect image' }), context },
    ];
    const ask = vi.fn().mockResolvedValue('2');

    await expect(choosePluginGutterMarker(markers, ask)).resolves.toBe(markers[1]);
    expect(ask).toHaveBeenCalledOnce();
  });
});
