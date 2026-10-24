import { useEffect, useRef, useState } from 'react';
/** Persisted in localStorage so the user's layout choice survives reloads. */
type LayoutMode = 'cards' | 'compact';
const LAYOUT_STORAGE_KEY = 'projectsList.layout';

function readStoredLayout(): LayoutMode {
  // Compact é o default — em projetos com 15+ entries, cards forçam
  // muita rolagem; compact deixa todos os projetos visíveis numa única
  // tela. User pode alternar pro grid via toggle no header.
  if (typeof window === 'undefined') return 'compact';
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    return raw === 'cards' ? 'cards' : 'compact';
  } catch {
    return 'compact';
  }
}


export function useProjectListPresentation() {
  const [layout, setLayout] = useState<LayoutMode>(readStoredLayout);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Persist layout choice; tiny enough that a debounce would be noise.
  useEffect(() => {
    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, layout);
    } catch {
      /* private mode / quota — best-effort */
    }
  }, [layout]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (
        event.key !== '/' ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT'
      ) {
        return;
      }
      event.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);


  return { layout, setLayout, searchInputRef };
}
