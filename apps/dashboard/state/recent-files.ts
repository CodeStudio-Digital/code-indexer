/**
 * Per-project MRU of opened files — feeds Search Everywhere's empty-query
 * state (IntelliJ "Recent Files"). Tracked by subscribing to the workspace
 * store's activeFilePath; persisted to localStorage (cap 30).
 */
import { useWorkspaceStore } from './workspace.js';

const KEY_PREFIX = 'mcp-ide:recent-files:';
const CAP = 30;

function load(projectId: number): string[] {
  try {
    return JSON.parse(localStorage.getItem(`${KEY_PREFIX}${projectId}`) ?? '[]') as string[];
  } catch { return []; }
}

export function recentFiles(projectId: number): string[] {
  return load(projectId);
}

let started = false;
let lastActive: string | null = null; // chave (projectId:path) do último ativo

/** Idempotent — call once from the Project view. */
export function startRecentFilesTracking(): void {
  if (started) return;
  started = true;
  useWorkspaceStore.subscribe((state) => {
    const active = state.activeFilePath;
    // Dedup pela TUPLA (projectId, path): dois projetos com o mesmo relpath ativo
    // (ex.: src/index.ts) não podem deixar um early-return mascarar o MRU do outro.
    const key = active != null ? `${state.activeProjectId}:${active}` : null;
    if (!active || key === lastActive) return;
    lastActive = key;
    const tab = state.openFiles.find(
      (f) => (f.kind === undefined || f.kind === 'file') && f.path === active && f.projectId === state.activeProjectId,
    );
    if (!tab || (tab.kind !== undefined && tab.kind !== 'file')) return;
    const projectId = tab.projectId;
    const next = [active, ...load(projectId).filter((p) => p !== active)].slice(0, CAP);
    try { localStorage.setItem(`${KEY_PREFIX}${projectId}`, JSON.stringify(next)); } catch { /* quota */ }
  });
}
