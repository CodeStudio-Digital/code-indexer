/**
 * Registro de "surfaces destacáveis" — telas pesadas que abrem como janela
 * Electron própria (popout) em vez de modal cramped. Cada entrada mapeia um
 * `kind` → título da janela + componente full-window. O componente é `lazy`
 * para que importar este registro (ex.: em openDetached, no caminho do file
 * tree) NÃO puxe o chunk pesado da surface.
 *
 * Para adicionar uma surface: criar o componente em ./surfaces/, registrá-lo
 * aqui com um `kind` único, e chamar `openDetached(kind, params)` no trigger.
 * O fluxo de janela (openInNewWindow → window:open → createAppWindow) e o shell
 * (PopoutRoot) já são genéricos — não precisam mudar.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/** Params de uma surface, sempre strings (vêm da query da rota). */
export type SurfaceParams = Record<string, string>;

interface DetachableSurface {
  kind: string;
  /** Título nativo da janela + document.title (mostrado na caption/taskbar). */
  titleFor: (params: SurfaceParams) => string;
  /** Componente full-window; recebe os params parseados da query. */
  Surface: LazyExoticComponent<ComponentType<{ params: SurfaceParams }>>;
}

function basename(p: string): string {
  const ix = p.lastIndexOf('/');
  return ix < 0 ? p : p.slice(ix + 1);
}

export const DETACHABLE_SURFACES: Record<string, DetachableSurface> = {
  'local-history': {
    kind: 'local-history',
    titleFor: (p) => `Local History — ${basename(p.path ?? '')}`,
    Surface: lazy(() => import('./surfaces/LocalHistorySurface.js')),
  },
  'task-manager': {
    kind: 'task-manager',
    // Fixed title: this surface is global, not scoped to a project or file.
    titleFor: () => 'CodeStudio — Task Manager',
    Surface: lazy(() => import('./surfaces/TaskManagerSurface.js')),
  },
  // futuro: 'project-settings', 'tool-stats', 'file-diff', ...
};
