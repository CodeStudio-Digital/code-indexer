import { useEffect } from 'react';

/**
 * Aplica o tema persistido (`localStorage 'theme'`) à classe `dark` do
 * documento e o mantém em sincronia com outras janelas via o evento
 * `storage`. Usado por surfaces que renderizam FORA do AppShell (ex.: a janela
 * popout / PopoutRoot), onde a lógica de tema do AppShell não monta. O AppShell
 * é quem escreve `localStorage 'theme'`; este hook só lê/aplica.
 */
function readDark(): boolean {
  if (typeof window === 'undefined') return false;
  const saved = window.localStorage.getItem('theme');
  if (saved) return saved === 'dark';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

export function useStoredTheme(): void {
  useEffect(() => {
    const apply = () => document.documentElement.classList.toggle('dark', readDark());
    apply();
    // `storage` dispara em OUTRAS janelas quando a do usuário troca o tema —
    // assim o popout acompanha o app ao vivo. `e.key === null` = clear().
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'theme' || e.key === null) apply();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
}
