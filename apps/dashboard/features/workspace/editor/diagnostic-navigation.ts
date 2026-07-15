import type * as MonacoNs from 'monaco-editor';
import i18n from '../../../i18n/index.js';

type Monaco = typeof MonacoNs;

export type DiagnosticDirection = 'next' | 'previous';

export const NEXT_DIAGNOSTIC_COMMAND = 'mcp.editor.problem.next';
export const PREVIOUS_DIAGNOSTIC_COMMAND = 'mcp.editor.problem.previous';

interface DiagnosticController extends MonacoNs.IDisposable {
  navigate: (direction: DiagnosticDirection) => void;
}

const controllers = new WeakMap<MonacoNs.editor.IStandaloneCodeEditor, DiagnosticController>();
let popupCounter = 0;

function comparePosition(
  marker: Pick<MonacoNs.editor.IMarker, 'startLineNumber' | 'startColumn'>,
  position: MonacoNs.IPosition,
): number {
  if (marker.startLineNumber !== position.lineNumber) return marker.startLineNumber - position.lineNumber;
  return marker.startColumn - position.column;
}

function containsPosition(marker: MonacoNs.editor.IMarker, position: MonacoNs.IPosition): boolean {
  const afterStart = position.lineNumber > marker.startLineNumber
    || (position.lineNumber === marker.startLineNumber && position.column >= marker.startColumn);
  const beforeEnd = position.lineNumber < marker.endLineNumber
    || (position.lineNumber === marker.endLineNumber && position.column <= marker.endColumn);
  return afterStart && beforeEnd;
}

function markerCode(marker: MonacoNs.editor.IMarker): string {
  if (!marker.code) return '';
  return typeof marker.code === 'string' ? marker.code : marker.code.value;
}

function markerKey(marker: MonacoNs.editor.IMarker): string {
  return [
    marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn,
    marker.severity, marker.source ?? '', markerCode(marker), marker.message,
  ].join(':');
}

function sortMarkers(markers: MonacoNs.editor.IMarker[]): MonacoNs.editor.IMarker[] {
  return [...markers].sort((left, right) =>
    left.startLineNumber - right.startLineNumber
    || left.startColumn - right.startColumn
    || right.severity - left.severity
    || left.message.localeCompare(right.message));
}

/**
 * Select the current diagnostic first when the cursor is inside it. Once the
 * popup is open, repeated next/previous commands advance with wraparound.
 */
export function diagnosticIndex(
  markers: MonacoNs.editor.IMarker[],
  position: MonacoNs.IPosition,
  direction: DiagnosticDirection,
  currentIndex = -1,
): number {
  if (markers.length === 0) return -1;
  if (currentIndex >= 0 && currentIndex < markers.length) {
    const delta = direction === 'next' ? 1 : -1;
    return (currentIndex + delta + markers.length) % markers.length;
  }

  const containing = markers.findIndex((marker) => containsPosition(marker, position));
  if (containing >= 0) return containing;
  if (direction === 'next') {
    const next = markers.findIndex((marker) => comparePosition(marker, position) > 0);
    return next >= 0 ? next : 0;
  }
  for (let index = markers.length - 1; index >= 0; index -= 1) {
    if (comparePosition(markers[index], position) < 0) return index;
  }
  return markers.length - 1;
}

function fileName(model: MonacoNs.editor.ITextModel): string {
  const path = (model.uri.fsPath || model.uri.path).replace(/\\/g, '/');
  return path.split('/').pop() || path;
}

function severityName(monaco: Monaco, severity: number): string {
  if (severity === monaco.MarkerSeverity.Error) return 'error';
  if (severity === monaco.MarkerSeverity.Warning) return 'warning';
  if (severity === monaco.MarkerSeverity.Info) return 'info';
  return 'hint';
}

/** Attach the floating problem navigator to one standalone editor instance. */
export function attachDiagnosticNavigation(
  editor: MonacoNs.editor.IStandaloneCodeEditor,
  monaco: Monaco,
): MonacoNs.IDisposable {
  controllers.get(editor)?.dispose();

  let disposed = false;
  let popup: { widget: MonacoNs.editor.IContentWidget; node: HTMLElement } | null = null;
  let currentMarkerKey: string | null = null;

  const closePopup = (focusEditor = false): void => {
    const current = popup;
    popup = null;
    currentMarkerKey = null;
    if (current) {
      editor.removeContentWidget(current.widget);
      current.node.remove();
    }
    if (focusEditor) editor.focus();
  };

  const markersForModel = (): MonacoNs.editor.IMarker[] => {
    const model = editor.getModel();
    if (!model || model.isDisposed()) return [];
    return sortMarkers(monaco.editor.getModelMarkers({ resource: model.uri }));
  };

  const showMarker = (
    markers: MonacoNs.editor.IMarker[],
    index: number,
    moveCursor = true,
  ): void => {
    const model = editor.getModel();
    const marker = markers[index];
    if (!model || model.isDisposed() || !marker) return;

    closePopup();
    currentMarkerKey = markerKey(marker);
    const anchor = { lineNumber: marker.startLineNumber, column: marker.startColumn };
    if (moveCursor) {
      editor.setPosition(anchor);
      editor.revealPositionInCenterIfOutsideViewport(anchor);
      editor.focus();
    }

    const node = document.createElement('section');
    node.className = 'mcp-symbol-navigation-popup mcp-diagnostic-navigation-popup';
    node.dataset.severity = severityName(monaco, marker.severity);
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-live', 'polite');
    node.setAttribute('aria-label', String(i18n.t('workspace:problemNavigation.ariaLabel')));

    const header = document.createElement('header');
    header.className = 'mcp-symbol-navigation-popup__header mcp-diagnostic-navigation-popup__header';
    const heading = document.createElement('strong');
    heading.textContent = fileName(model);
    heading.title = heading.textContent;

    const controls = document.createElement('div');
    controls.className = 'mcp-diagnostic-navigation-popup__controls';
    const count = document.createElement('span');
    count.className = 'mcp-symbol-navigation-popup__count mcp-diagnostic-navigation-popup__count';
    count.textContent = String(i18n.t('workspace:problemNavigation.position', {
      current: index + 1,
      count: markers.length,
    }));
    const previousButton = document.createElement('button');
    previousButton.type = 'button';
    previousButton.className = 'mcp-diagnostic-navigation-popup__nav';
    previousButton.setAttribute('aria-label', String(i18n.t('workspace:problemNavigation.previous')));
    previousButton.title = String(i18n.t('workspace:problemNavigation.previous'));
    previousButton.textContent = '↑';
    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.className = 'mcp-diagnostic-navigation-popup__nav';
    nextButton.setAttribute('aria-label', String(i18n.t('workspace:problemNavigation.next')));
    nextButton.title = String(i18n.t('workspace:problemNavigation.next'));
    nextButton.textContent = '↓';
    controls.append(count, previousButton, nextButton);

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'mcp-symbol-navigation-popup__close';
    closeButton.setAttribute('aria-label', String(i18n.t('workspace:problemNavigation.close')));
    closeButton.title = String(i18n.t('workspace:problemNavigation.close'));
    closeButton.textContent = '×';
    header.append(heading, controls, closeButton);

    const body = document.createElement('div');
    body.className = 'mcp-diagnostic-navigation-popup__body';
    const icon = document.createElement('span');
    icon.className = 'mcp-diagnostic-navigation-popup__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = marker.severity === monaco.MarkerSeverity.Error ? '×' : '!';
    const content = document.createElement('div');
    content.className = 'mcp-diagnostic-navigation-popup__content';
    const message = document.createElement('div');
    message.className = 'mcp-diagnostic-navigation-popup__message';
    message.textContent = marker.message;
    message.title = marker.message;
    content.append(message);
    const code = markerCode(marker);
    if (marker.source || code) {
      const meta = document.createElement('div');
      meta.className = 'mcp-diagnostic-navigation-popup__meta';
      meta.textContent = marker.source && code
        ? `${marker.source} (${code})`
        : marker.source || code;
      content.append(meta);
    }
    body.append(icon, content);
    node.append(header, body);

    const popupId = `mcp-diagnostic-navigation-${++popupCounter}`;
    const widget: MonacoNs.editor.IContentWidget = {
      allowEditorOverflow: true,
      getId: () => popupId,
      getDomNode: () => node,
      getPosition: () => ({
        position: anchor,
        preference: [
          monaco.editor.ContentWidgetPositionPreference.BELOW,
          monaco.editor.ContentWidgetPositionPreference.ABOVE,
        ],
      }),
    };
    popup = { widget, node };

    previousButton.addEventListener('click', () => controller.navigate('previous'));
    nextButton.addEventListener('click', () => controller.navigate('next'));
    closeButton.addEventListener('click', () => closePopup(true));
    node.addEventListener('mousedown', (event) => event.stopPropagation());
    editor.addContentWidget(widget);
    editor.layoutContentWidget(widget);
  };

  const controller: DiagnosticController = {
    navigate(direction) {
      if (disposed) return;
      const markers = markersForModel();
      if (markers.length === 0) {
        closePopup();
        return;
      }
      const position = editor.getPosition() ?? {
        lineNumber: markers[0].startLineNumber,
        column: markers[0].startColumn,
      };
      const openIndex = popup && currentMarkerKey
        ? markers.findIndex((marker) => markerKey(marker) === currentMarkerKey)
        : -1;
      const index = diagnosticIndex(markers, position, direction, openIndex);
      showMarker(markers, index);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      closePopup();
      nextAction.dispose();
      previousAction.dispose();
      modelChange.dispose();
      markerChange.dispose();
      keyDown.dispose();
      editorDispose.dispose();
      if (controllers.get(editor) === controller) controllers.delete(editor);
    },
  };

  const nextAction = editor.addAction({
    id: NEXT_DIAGNOSTIC_COMMAND,
    label: String(i18n.t('workspace:problemNavigation.next')),
    run: () => controller.navigate('next'),
  });
  const previousAction = editor.addAction({
    id: PREVIOUS_DIAGNOSTIC_COMMAND,
    label: String(i18n.t('workspace:problemNavigation.previous')),
    run: () => controller.navigate('previous'),
  });
  const modelChange = editor.onDidChangeModel(() => closePopup());
  const markerChange = monaco.editor.onDidChangeMarkers((resources) => {
    const model = editor.getModel();
    const openKey = currentMarkerKey;
    if (!popup || !model || !openKey
      || !resources.some((resource) => resource.toString() === model.uri.toString())) return;
    const markers = markersForModel();
    const index = markers.findIndex((marker) => markerKey(marker) === openKey);
    if (index < 0) closePopup();
    else showMarker(markers, index, false);
  });
  const keyDown = editor.onKeyDown((event) => {
    if (!popup || event.browserEvent.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closePopup(true);
  });
  const editorDispose = editor.onDidDispose(() => controller.dispose());

  controllers.set(editor, controller);
  return controller;
}

/** Used by the global command dispatcher / Command Palette. */
export function navigateDiagnostic(
  editor: MonacoNs.editor.IStandaloneCodeEditor,
  direction: DiagnosticDirection,
): boolean {
  const controller = controllers.get(editor);
  if (!controller) return false;
  controller.navigate(direction);
  return true;
}
