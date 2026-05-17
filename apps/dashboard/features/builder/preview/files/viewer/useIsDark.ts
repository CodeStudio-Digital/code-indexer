import { useEffect, useState } from 'react';

/**
 * Reactive read of the app's dark-mode flag (App.tsx toggles `dark` on
 * `<html>`). A MutationObserver on `class` keeps the viewer theme in
 * sync when the user flips the theme switch without re-mounting.
 */
export function useIsDark(): boolean {
  const [dark, setDark] = useState<boolean>(() =>
    typeof document !== 'undefined'
      ? document.documentElement.classList.contains('dark')
      : false,
  );
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const target = document.documentElement;
    const observer = new MutationObserver(() => {
      setDark(target.classList.contains('dark'));
    });
    observer.observe(target, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}
