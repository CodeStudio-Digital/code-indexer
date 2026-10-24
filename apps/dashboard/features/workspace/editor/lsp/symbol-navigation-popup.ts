import type * as MonacoNs from 'monaco-editor';
import i18n from '../../../../i18n/index.js';
import { apiCall } from '../../../../lib/api-client.js';
import { navigateToProjectLocation } from '../nav-commands.js';
import type { LspLocationDTO, Monaco, Position } from './dto.js';

interface ProjectDTO { root_path?: string }

const projectRoots = new Map<number, Promise<string | null>>();
const openPopups = new WeakMap<MonacoNs.editor.IStandaloneCodeEditor, () => void>();
let popupCounter = 0;

function projectRoot(projectId: number): Promise<string | null> {
  const cached = projectRoots.get(projectId);
  if (cached) return cached;
  const pending = apiCall<ProjectDTO>('projects.get', { id: projectId })
    .then((project) => project.root_path ?? null)
    .catch(() => {
      projectRoots.delete(projectId);
      return null;
    });
  projectRoots.set(projectId, pending);
  return pending;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/$/, '');
}

function relativePath(root: string | null, file: string): string | null {
  const normalizedFile = normalizePath(file);
  if (!root) return /^[a-zA-Z]:\//.test(normalizedFile) ? null : normalizedFile.replace(/^\/+/, '');
  const normalizedRoot = normalizePath(root);
  const prefix = `${normalizedRoot}/`;
  if (!normalizedFile.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  return normalizedFile.slice(prefix.length);
}

function shortName(path: string): string {
  return path.split('/').pop() ?? path;
}

function uniqueLocations(locations: LspLocationDTO[]): LspLocationDTO[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = `${normalizePath(location.file).toLowerCase()}:${location.range.start.line}:${location.range.start.column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Lightweight IntelliJ-style usages popup that works in standalone Monaco. */
export async function showSymbolNavigationPopup(
  editor: MonacoNs.editor.IStandaloneCodeEditor,
  monaco: Monaco,
  projectId: number,
  anchor: Position,
  locations: LspLocationDTO[],
  title: string,
): Promise<void> {
  openPopups.get(editor)?.();
  const rootPath = await projectRoot(projectId);
  const currentModel = editor.getModel();
  if (!currentModel || currentModel.isDisposed()) return;

  const entries = uniqueLocations(locations).map((location) => ({
    location,
    path: relativePath(rootPath, location.file),
  }));
  const popupId = `mcp-symbol-navigation-${++popupCounter}`;
  const domNode = document.createElement('section');
  domNode.className = 'mcp-symbol-navigation-popup';
  domNode.setAttribute('role', 'dialog');
  domNode.setAttribute('aria-label', title);
  domNode.tabIndex = -1;

  const header = document.createElement('header');
  header.className = 'mcp-symbol-navigation-popup__header';
  const heading = document.createElement('strong');
  heading.textContent = title;
  const count = document.createElement('span');
  count.className = 'mcp-symbol-navigation-popup__count';
  count.textContent = String(i18n.t('workspace:symbolNavigation.resultCount', { count: entries.length }));
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'mcp-symbol-navigation-popup__close';
  closeButton.setAttribute('aria-label', String(i18n.t('workspace:symbolNavigation.close')));
  closeButton.textContent = '×';
  header.append(heading, count, closeButton);

  const filter = document.createElement('input');
  filter.type = 'search';
  filter.className = 'mcp-symbol-navigation-popup__filter';
  filter.placeholder = String(i18n.t('workspace:symbolNavigation.filterPlaceholder'));
  filter.setAttribute('aria-label', filter.placeholder);

  const list = document.createElement('div');
  list.className = 'mcp-symbol-navigation-popup__list';
  list.setAttribute('role', 'listbox');
  const empty = document.createElement('div');
  empty.className = 'mcp-symbol-navigation-popup__empty';
  empty.textContent = String(i18n.t('workspace:symbolNavigation.noFilteredResults'));
  empty.hidden = true;

  const resultButtons: HTMLButtonElement[] = [];
  for (const entry of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mcp-symbol-navigation-popup__result';
    button.setAttribute('role', 'option');
    button.dataset.search = (entry.path ?? entry.location.file).toLowerCase();
    const icon = document.createElement('span');
    icon.className = 'mcp-symbol-navigation-popup__icon';
    icon.textContent = '⌘';
    const label = document.createElement('span');
    label.className = 'mcp-symbol-navigation-popup__label';
    const filename = document.createElement('strong');
    filename.textContent = shortName(entry.path ?? entry.location.file);
    const path = document.createElement('span');
    path.textContent = entry.path ?? entry.location.file;
    label.append(filename, path);
    const position = document.createElement('span');
    position.className = 'mcp-symbol-navigation-popup__position';
    position.textContent = `${entry.location.range.start.line}:${entry.location.range.start.column}`;
    button.append(icon, label, position);
    button.addEventListener('click', () => {
      if (!entry.path) return;
      dispose();
      navigateToProjectLocation({
        projectId,
        path: entry.path,
        line: entry.location.range.start.line,
        column: entry.location.range.start.column,
      });
    });
    if (!entry.path) button.disabled = true;
    resultButtons.push(button);
    list.append(button);
  }
  list.append(empty);
  domNode.append(header, filter, list);

  const widget: MonacoNs.editor.IContentWidget = {
    getId: () => popupId,
    getDomNode: () => domNode,
    getPosition: () => ({
      position: { lineNumber: anchor.line, column: anchor.column },
      preference: [
        monaco.editor.ContentWidgetPositionPreference.BELOW,
        monaco.editor.ContentWidgetPositionPreference.ABOVE,
      ],
    }),
  };
  const modelChange = editor.onDidChangeModel(() => dispose());
  const editorDispose = editor.onDidDispose(() => dispose());
  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    modelChange.dispose();
    editorDispose.dispose();
    editor.removeContentWidget(widget);
    domNode.remove();
    if (openPopups.get(editor) === dispose) openPopups.delete(editor);
  }
  openPopups.set(editor, dispose);
  closeButton.addEventListener('click', dispose);
  domNode.addEventListener('mousedown', (event) => event.stopPropagation());
  domNode.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      dispose();
      editor.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const visible = resultButtons.filter((button) => !button.hidden && !button.disabled);
    if (visible.length === 0) return;
    event.preventDefault();
    const current = visible.indexOf(document.activeElement as HTMLButtonElement);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    visible[(current + delta + visible.length) % visible.length].focus();
  });
  filter.addEventListener('input', () => {
    const query = filter.value.trim().toLowerCase();
    let visibleCount = 0;
    for (const button of resultButtons) {
      button.hidden = !button.dataset.search?.includes(query);
      if (!button.hidden) visibleCount += 1;
    }
    empty.hidden = visibleCount !== 0;
  });

  editor.addContentWidget(widget);
  editor.layoutContentWidget(widget);
  queueMicrotask(() => { if (!disposed) filter.focus(); });
}

function __resetSymbolNavigationPopupForTests(): void {
  projectRoots.clear();
}
