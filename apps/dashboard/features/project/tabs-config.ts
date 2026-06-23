/**
 * Configuração das abas do ProjectView (extraído — W4 decompose). Compartilhado
 * entre o shell (ProjectView), o rail (ProjectRail) e o roteador de conteúdo, evitando
 * import circular.
 */
import {
  BookOpen,
  Brain,
  Database,
  FileCode2,
  GitBranch,
  MessageSquareCode,
  Server,
  Webhook,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

// Built-in tab ids (chat/files/search/git/snapshots + analytics) plus any
// plugin-contributed tool-window id — so widened to `string`.
export type ProjectTabId = string;

export interface TabDef {
  id: ProjectTabId;
  label: string;
  icon: LucideIcon;
  /** Group separates the IDE-core tools (top) from the analytics-style
   *  tools (bottom). Visually rendered as a divider in the rail. */
  group: 'core' | 'analytics' | 'plugins';
}

export const TABS: TabDef[] = [
  { id: 'chat',         label: 'Sessões',       icon: MessageSquareCode, group: 'core' },
  { id: 'files',        label: 'Files',         icon: FileCode2,         group: 'core' },
  { id: 'git',          label: 'Git',           icon: GitBranch,         group: 'core' },
  // 'runners' migrou para o BottomPanel (aba ao lado de Terminal/Problems/
  // Output/Find) — rodar scripts e ver saída de PTY são a mesma atividade.
  { id: 'api',          label: 'API',           icon: Webhook,           group: 'core' },
  { id: 'databases',    label: 'Databases',     icon: Server,            group: 'core' },
  // Docs Studio is NOT a rail tab — it lives inside the API tab (Client / Docs
  // toggle) to keep everything API-related in one place.
  { id: 'diagrams',     label: 'Diagrams',      icon: Workflow,          group: 'core' },
  // Index — aba unificada: busca (hybrid/FTS/vector), controle do indexer (run +
  // embeddings + histórico), arquivos indexados, dependências, arquitetura, diff
  // entre runs e custos. Tudo é faceta do MESMO índice, então vive sob um ícone
  // só (antes eram 7). O painel real fica em tabs/index-workspace/IndexWorkspace.tsx.
  { id: 'index',        label: 'Index',         icon: Database,          group: 'analytics' },
  // Snapshots + Memória — artefatos de contexto, logo abaixo do índice. Memória
  // é GLOBAL do usuário (não do projeto), por isso fora do Index.
  { id: 'snapshots',    label: 'Snapshots',     icon: BookOpen,          group: 'analytics' },
  { id: 'memory',       label: 'Memória',       icon: Brain,             group: 'analytics' },
];
