/**
 * Roteador de conteúdo das abas do ProjectView (W4 decompose + W2 keep-alive).
 *
 * Keep-alive (flag ON por padrão): as abas caras/estadoful — `chat`, `files`,
 * `git` e `databases` — ficam MONTADAS e apenas escondidas via CSS ao trocar de
 * aba, em vez de desmontar/remontar. Isso preserva o estado do Monaco
 * (cursor/scroll/undo), a sessão de chat (SSE) e o client de DB (conexões,
 * árvore, abas/query editors) através da navegação. Files e Git compartilham UM
 * editor (CodeSurface), então no máximo 1 Monaco + 1 AgentChat ficam vivos.
 *
 * As abas transitórias (snapshots/api/preview/diagrams/analytics/plugin) seguem
 * conditional-render (montam ao entrar, desmontam ao sair) por cima das escondidas.
 *
 * Rollback (renderer, runtime): `localStorage['mcp-ide:tab-keepalive'] = '0'` + reload
 * → conditional-render clássico (remonta a aba a cada troca).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../../lib/utils.js';
import { markRouteEvent } from '../../../lib/perf/route-startup-metrics.js';
import type { ContribToolWindow } from '../../../state/contribution-registry.js';
import type { ProjectTabId } from '../tabs-config.js';
import { CodeSurface } from './CodeSurface.js';
import { ChatSurface } from './ChatSurface.js';
import { TransientSurface } from './TransientSurface.js';
import type { PreviewFramework } from '../builder/useSelectorMode.js';

/** Abas mantidas vivas (escondidas via CSS) na troca de aba. */
const KEEP_ALIVE = new Set<ProjectTabId>(['chat', 'files', 'git', 'databases']);

const KEEPALIVE_FLAG = 'mcp-ide:tab-keepalive';
/** Default ON. `'0'` no localStorage desliga (rollback). Espelha nsModelUrisEnabled. */
function keepAliveEnabled(): boolean {
  try {
    return typeof localStorage === 'undefined' || localStorage.getItem(KEEPALIVE_FLAG) !== '0';
  } catch {
    return true;
  }
}

export interface TabContentProps {
  tab: ProjectTabId;
  projectId: number;
  projectName: string;
  /** Native `root_path` — forwarded to CodeSurface → file tree menu. */
  projectRoot?: string | null;
  initialSessionId?: string;
  onOpenFile: (path: string) => void;
  activeFilePath: string | null;
  contribWindows: ContribToolWindow[];
  /** Set for Builder projects → chat tab splits into chat | live preview. */
  builderJson: { stack: string; port: number } | null;
  /** Builder OR any project with a running dev server → preview available. */
  previewEnabled: boolean;
  /** Inferred framework → preview auto-picks React-native vs universal picker. */
  framework?: PreviewFramework;
}

/**
 * Pane keep-alive: visibility:hidden (NÃO display:none) mantém a CAIXA de layout em
 * tamanho cheio, então o Monaco fica sempre corretamente dimensionado e o reveal não
 * dá 0×0/flicker (R3). Todos os panes ficam empilhados em `absolute inset-0`.
 */
function KeepAlivePane({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  return (
    <div aria-hidden={hidden} className={cn('absolute inset-0', hidden && 'invisible pointer-events-none')}>
      {children}
    </div>
  );
}

export function TabContent(props: TabContentProps) {
  const { tab, projectId } = props;
  const isCode = tab === 'files' || tab === 'git';
  const isDatabases = tab === 'databases';

  // Hooks chamados INCONDICIONALMENTE (rules of hooks) — só usados no caminho keep-alive.
  const [codeSeen, setCodeSeen] = useState(isCode);
  const [chatSeen, setChatSeen] = useState(tab === 'chat');
  const [databasesSeen, setDatabasesSeen] = useState(isDatabases);
  // Último modo de código (files/git) — preserva o painel esquerdo quando escondido.
  const lastCodeMode = useRef<'files' | 'git'>(isCode ? (tab as 'files' | 'git') : 'files');
  if (isCode) lastCodeMode.current = tab as 'files' | 'git';
  useEffect(() => {
    if (tab === 'files' || tab === 'git') setCodeSeen(true);
    if (tab === 'chat') setChatSeen(true);
    if (tab === 'databases') setDatabasesSeen(true);
  }, [tab]);
  useEffect(() => {
    markRouteEvent('TabContent:mounted', { projectId, tab });
  }, [projectId, tab]);

  const renderCode = (): ReactNode => (
    <CodeSurface
      mode={lastCodeMode.current}
      visible={isCode}
      projectId={props.projectId}
      projectName={props.projectName}
      projectRoot={props.projectRoot}
      activeFilePath={props.activeFilePath}
      onOpenFile={props.onOpenFile}
    />
  );
  const renderChat = (): ReactNode => (
    <ChatSurface
      projectId={props.projectId}
      projectName={props.projectName}
      initialSessionId={props.initialSessionId}
      builderJson={props.builderJson}
      previewEnabled={props.previewEnabled}
      framework={props.framework}
    />
  );
  const renderDatabases = (): ReactNode => (
    <TransientSurface
      tab="databases"
      projectId={props.projectId}
      projectName={props.projectName}
      onOpenFile={props.onOpenFile}
      contribWindows={props.contribWindows}
      builderJson={props.builderJson}
      framework={props.framework}
    />
  );
  const renderTransient = (): ReactNode => (
    <TransientSurface
      tab={tab}
      projectId={props.projectId}
      projectName={props.projectName}
      onOpenFile={props.onOpenFile}
      contribWindows={props.contribWindows}
      builderJson={props.builderJson}
      framework={props.framework}
    />
  );

  // Fallback (flag OFF): conditional-render — monta a aba ativa, desmonta as demais.
  if (!keepAliveEnabled()) {
    if (isCode) return <>{renderCode()}</>;
    if (tab === 'chat') return <>{renderChat()}</>;
    return <>{renderTransient()}</>;
  }

  // Keep-alive: chat + code (files/git) + databases montados (escondidos via CSS); transitórias por cima.
  return (
    <div className="relative h-full min-h-0">
      {codeSeen && <KeepAlivePane hidden={!isCode}>{renderCode()}</KeepAlivePane>}
      {chatSeen && <KeepAlivePane hidden={tab !== 'chat'}>{renderChat()}</KeepAlivePane>}
      {databasesSeen && <KeepAlivePane hidden={!isDatabases}>{renderDatabases()}</KeepAlivePane>}
      {!KEEP_ALIVE.has(tab) && <div className="absolute inset-0">{renderTransient()}</div>}
    </div>
  );
}
