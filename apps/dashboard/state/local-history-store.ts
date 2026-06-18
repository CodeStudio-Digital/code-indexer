/**
 * Estado de abertura do Local History (qual arquivo está com o histórico
 * aberto). O diálogo é modal/global; a UI lê este store para abrir/fechar.
 */
import { create } from 'zustand';

/** Mirror de api-bus `HistoryRevision` (renderer não importa @mcp/api-bus). */
export interface HistoryRevision {
  id: number;
  path: string;
  content_hash: string | null;
  size: number;
  kind: 'save' | 'external' | 'pre-delete' | 'pre-agent' | 'manual';
  label: string | null;
  existed_before: number;
  oversized: number;
  created_at: string;
}

interface LocalHistoryState {
  target: { projectId: number; path: string } | null;
  open: (projectId: number, path: string) => void;
  close: () => void;
}

export const useLocalHistory = create<LocalHistoryState>((set) => ({
  target: null,
  open: (projectId, path) => set({ target: { projectId, path } }),
  close: () => set({ target: null }),
}));
