/**
 * One theme owner for the process-wide Monaco singleton.
 *
 * `monaco.editor.setTheme` is global, even when an editor is hidden. API,
 * history, merge and SFTP surfaces therefore must not choose independent
 * `vs-dark` themes: mounting one of them would repaint the workspace editor.
 * The focused workspace language owns the optional per-language override and
 * every auxiliary editor consumes the same snapshot.
 */
import { useSyncExternalStore } from 'react';
import type * as MonacoNs from 'monaco-editor';
import {
  editorThemeSnapshot,
  resolveThemeId,
  useEditorTheme,
} from '../state/editor-theme.js';

type Monaco = typeof MonacoNs;
type Appearance = 'dark' | 'light';

const listeners = new Set<() => void>();
let monacoRef: Monaco | null = null;
let activeLanguage: string | null = null;
let storeSubscription: (() => void) | null = null;
let appearanceObserver: MutationObserver | null = null;

function appearance(): Appearance {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
    ? 'dark'
    : 'light';
}

function resolveCurrentTheme(): string {
  return resolveThemeId({
    appearance: appearance(),
    languageId: activeLanguage,
    state: editorThemeSnapshot(),
  });
}

let currentThemeId = resolveCurrentTheme();

function publish(next: string, forceApply = false): void {
  const changed = next !== currentThemeId;
  currentThemeId = next;
  if (changed || forceApply) monacoRef?.editor.setTheme(next);
  if (changed) listeners.forEach((listener) => listener());
}

/** Called once by setupMonaco, after custom themes have been registered. */
export function setupSharedMonacoTheme(monaco: Monaco): void {
  monacoRef = monaco;
  if (!storeSubscription) {
    storeSubscription = useEditorTheme.subscribe(() => publish(resolveCurrentTheme()));
  }
  if (!appearanceObserver && typeof document !== 'undefined') {
    appearanceObserver = new MutationObserver(() => publish(resolveCurrentTheme()));
    appearanceObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }
  publish(resolveCurrentTheme(), true);
}

/**
 * Make the focused workspace language the global owner and re-assert it even
 * when the id did not change (a retained third-party Monaco may have painted
 * another global theme since the last workspace render).
 */
export function activateSharedMonacoTheme(languageId: string | null): string {
  activeLanguage = languageId;
  const next = resolveCurrentTheme();
  publish(next, true);
  return next;
}

/** Re-apply after a retained primary surface becomes visible again. */
export function reapplySharedMonacoTheme(): void {
  publish(resolveCurrentTheme(), true);
}

export function sharedMonacoThemeId(): string {
  return currentThemeId;
}

/** Every auxiliary @monaco-editor/react surface must pass this same theme. */
export function useSharedMonacoTheme(): string {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sharedMonacoThemeId,
    sharedMonacoThemeId,
  );
}

