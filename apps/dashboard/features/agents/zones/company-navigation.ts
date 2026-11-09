import type { Zone } from './types.js';

export const COMPANY_AREAS = [
  { id: 'conversation', label: 'company.conversation', fallback: 'Conversation', zone: 'work', tab: 'board', tabs: ['board', 'archived'] },
  { id: 'tasks', label: 'company.tasks', fallback: 'Tasks', zone: 'work', tab: 'kanban', tabs: ['kanban'] },
  { id: 'changes', label: 'company.changes', fallback: 'Changes', zone: 'data', tab: 'snapshots', tabs: ['snapshots', 'files', 'git'] },
  { id: 'qa', label: 'company.previewQa', fallback: 'Preview & QA', zone: 'build', tab: 'tests', tabs: ['tests'] },
  { id: 'knowledge', label: 'company.knowledge', fallback: 'Knowledge', zone: 'build', tab: 'docs', tabs: ['docs', 'drive', 'memory', 'api'] },
] as const;

export function companyAreaForTab(tab: string) {
  return COMPANY_AREAS.find((area) => (area.tabs as readonly string[]).includes(tab)) ?? COMPANY_AREAS[0];
}

export const COMPANY_DETAIL_TABS: Record<string, { zone: Zone; label: string; fallback: string }> = {
  board: { zone: 'work', label: 'company.conversation', fallback: 'Conversation' },
  archived: { zone: 'data', label: 'company.archived', fallback: 'History' },
  snapshots: { zone: 'data', label: 'company.review', fallback: 'Review & undo' },
  files: { zone: 'build', label: 'company.files', fallback: 'Files' },
  git: { zone: 'build', label: 'company.git', fallback: 'Git' },
  docs: { zone: 'build', label: 'company.documents', fallback: 'Documents' },
  drive: { zone: 'data', label: 'company.artifacts', fallback: 'Shared files' },
  memory: { zone: 'work', label: 'company.memory', fallback: 'Memory' },
  api: { zone: 'build', label: 'company.apiReference', fallback: 'API' },
};
