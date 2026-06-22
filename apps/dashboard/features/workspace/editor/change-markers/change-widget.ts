/**
 * Hosts the change-marker toolbar in a Monaco content widget so it anchors to a
 * line and follows scroll. The toolbar is plain DOM (see change-toolbar-dom);
 * this module owns the widget lifecycle — position, show/hide, and disposal.
 */

import type * as MonacoNs from 'monaco-editor';
import {
  buildChangeToolbar,
  type ChangeToolbarActions,
  type ChangeToolbarLabels,
} from './change-toolbar-dom.js';

export interface ChangeWidget {
  show(lineNumber: number, baselineText: string): void;
  hide(): void;
  isOpen(): boolean;
  dispose(): void;
}

export function createChangeWidget(
  editor: MonacoNs.editor.IStandaloneCodeEditor,
  monaco: typeof MonacoNs,
  labels: ChangeToolbarLabels,
  actions: ChangeToolbarActions,
): ChangeWidget {
  const toolbar = buildChangeToolbar(labels, actions);
  const domNode = document.createElement('div');
  domNode.className = 'mcp-change-tb-host';
  domNode.appendChild(toolbar.element);
  // Clicks inside the toolbar must NOT bubble to the editor's onMouseDown
  // (which treats a non-marker click as "dismiss"). Esc closes from here too,
  // since the commit input swallows key events before they reach the editor.
  domNode.addEventListener('mousedown', (e) => e.stopPropagation());
  domNode.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') actions.onClose();
  });

  let line = 1;
  let open = false;

  const widget: MonacoNs.editor.IContentWidget = {
    getId: () => 'mcp.change-marker.toolbar',
    getDomNode: () => domNode,
    getPosition: () =>
      open
        ? {
            position: { lineNumber: line, column: 1 },
            preference: [
              monaco.editor.ContentWidgetPositionPreference.ABOVE,
              monaco.editor.ContentWidgetPositionPreference.BELOW,
            ],
          }
        : null,
  };
  editor.addContentWidget(widget);

  return {
    show(lineNumber, baselineText) {
      line = lineNumber;
      open = true;
      toolbar.update({ baselineText });
      editor.layoutContentWidget(widget);
    },
    hide() {
      if (!open) return;
      open = false;
      editor.layoutContentWidget(widget);
    },
    isOpen: () => open,
    dispose() {
      open = false;
      editor.removeContentWidget(widget);
      toolbar.destroy();
    },
  };
}
