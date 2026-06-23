import { useEffect, useState } from 'react';

/**
 * State + actions for the custom (frameless) title bar. Mirrors the
 * `windowControls` surface exposed by the Electron preload, with a clean
 * no-op fallback for the browser/web build where `window.electronAPI` is
 * undefined (controls hide, drag is inert, the bar never dims).
 */
export interface WindowChrome {
  /** `'win32' | 'darwin' | 'linux'` in Electron, `'web'` in the browser. */
  platform: NodeJS.Platform | 'web';
  /** True only inside the Electron renderer (controls are wired). */
  isElectron: boolean;
  isMaximized: boolean;
  isFocused: boolean;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
}

const noop = (): void => undefined;

export function useWindowChrome(): WindowChrome {
  const controls = typeof window !== 'undefined' ? window.electronAPI?.windowControls : undefined;
  const platform = (typeof window !== 'undefined' && window.electronAPI?.platform) || 'web';
  const isElectron = !!controls;

  const [isMaximized, setIsMaximized] = useState(false);
  const [isFocused, setIsFocused] = useState(true);

  useEffect(() => {
    if (!controls) return;
    let alive = true;
    void controls.isMaximized().then((v) => {
      if (alive) setIsMaximized(v);
    });
    const offMax = controls.onMaximizedChanged(setIsMaximized);
    const offFocus = controls.onFocusChanged(setIsFocused);
    return () => {
      alive = false;
      offMax();
      offFocus();
    };
  }, [controls]);

  return {
    platform,
    isElectron,
    isMaximized,
    isFocused,
    minimize: controls ? () => controls.minimize() : noop,
    toggleMaximize: controls ? () => controls.toggleMaximize() : noop,
    close: controls ? () => controls.close() : noop,
  };
}
