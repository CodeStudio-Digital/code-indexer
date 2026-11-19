import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, FileCode2, Loader2 } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog.js';
import { apiBaseUrl } from '../../../lib/api-client-transport.js';
import { useActiveSurface } from '../../../state/active-surface.js';
import { useWorkspaceStore } from '../../../state/workspace.js';
import { worktreeKey } from '../../../state/worktree-selection.js';
import { editorMediaKind } from '../../workspace/editor/media-types.js';
import { navigateToProjectLocation } from '../../workspace/editor/nav-commands.js';
import { Markdown } from './Markdown.js';
import { CopyTextButton } from './CopyTextButton.js';
import { ChatFileLinkContext } from './chat-file-link-context.js';
import type { FileLink } from './markdown-links.js';

interface LinkedFile {
  path: string;
  absolutePath: string;
  projectId: number | null;
  worktreePath: string | null;
  content: string;
  isBinary: boolean;
  truncated: boolean;
  imageType?: string;
}

interface Navigation {
  endpoint: string;
  history: FileLink[];
  trigger: HTMLElement;
}

export function ChatFileLinks({ endpoint, sourceFile, children }: { endpoint: string | null; sourceFile?: string; children: ReactNode }) {
  const [navigation, setNavigation] = useState<Navigation | null>(null);
  const open = useCallback((link: FileLink, trigger: HTMLElement) => {
    if (endpoint) setNavigation({ endpoint, history: [link], trigger });
  }, [endpoint]);
  const scope = useMemo(() => ({ open, sourceFile }), [open, sourceFile]);
  // Never reuse a previous session's document or move its scroll position.
  useEffect(() => { setNavigation(current => current?.endpoint === endpoint ? current : null); }, [endpoint]);
  const active = navigation?.endpoint === endpoint ? navigation : null;
  const link = active?.history.at(-1);
  const follow = (child: FileLink) => setNavigation(current => current && { ...current, history: [...current.history, child] });
  return <ChatFileLinkContext.Provider value={scope}>
    {children}
    {active && link && <Dialog open onOpenChange={value => { if (!value) setNavigation(null); }}>
      <DialogContent className="flex max-h-[85vh] w-[calc(100%-2rem)] max-w-4xl flex-col gap-3 overflow-hidden"
        onCloseAutoFocus={event => {
          event.preventDefault();
          if (active.trigger.isConnected) active.trigger.focus({ preventScroll: true });
        }}>
        <DialogHeader className="min-w-0 pr-8">
          <DialogTitle className="break-words">{link.path.split('/').at(-1) || link.path}</DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">{link.path}{link.line ? ':' + link.line + (link.column && link.column > 1 ? ':' + link.column : '') : ''}</DialogDescription>
        </DialogHeader>
        <FilePreview key={active.endpoint + ':' + link.path} endpoint={active.endpoint} link={link} follow={follow}
          back={active.history.length > 1 ? () => setNavigation({ ...active, history: active.history.slice(0, -1) }) : undefined}
          close={() => setNavigation(null)} />
      </DialogContent>
    </Dialog>}
  </ChatFileLinkContext.Provider>;
}

const errorMessages = {
  invalid: 'linkedFile.invalid', missing: 'linkedFile.missing', workspace: 'linkedFile.workspace',
  outside: 'linkedFile.outside', denied: 'linkedFile.denied', notFile: 'linkedFile.notFile', unreadable: 'linkedFile.unreadable',
} as const;

function FilePreview({ endpoint, link, follow, back, close }: {
  endpoint: string; link: FileLink; follow: (link: FileLink) => void; back?: () => void; close: () => void;
}) {
  const { t } = useTranslation('chat');
  const [file, setFile] = useState<LinkedFile | null>(null);
  const [error, setError] = useState<keyof typeof errorMessages | null>(null);
  const [attempt, setAttempt] = useState(0);
  const surface = useActiveSurface(state => state.projectTab);
  useEffect(() => {
    const controller = new AbortController();
    async function read() {
      const url = apiBaseUrl() + endpoint + '?' + new URLSearchParams({ path: link.path });
      const response = await fetch(url, { signal: controller.signal });
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (response.ok) setFile(data);
      else setError(Object.hasOwn(errorMessages, data?.error) ? data.error : 'unreadable');
    }
    void read().catch(() => { if (!controller.signal.aborted) setError('unreadable'); });
    return () => controller.abort();
  }, [endpoint, link.path, attempt]);
  const sameWorkspace = surface && file?.projectId != null && (
    (surface.workspaceId === file.projectId && !file.worktreePath)
    || (surface.projectId === file.projectId && worktreeKey(surface.worktreePath) === worktreeKey(file.worktreePath)));
  const workspaceId = sameWorkspace ? surface.workspaceId : null;
  const media = file ? editorMediaKind(file.path) : null;
  const mediaFile = !!media && media !== 'html' && media !== 'svg';
  const canCopy = file && !file.isBinary && !mediaFile && file.content.length > 0;
  const canOpenEditor = workspaceId != null && file && (!file.isBinary || mediaFile);
  return <>
    <div className="min-h-0 overflow-auto py-1" data-linked-file-preview>
      {error ? <div role="alert" className="space-y-3">
        <p>{t(errorMessages[error])}</p>
        <Button size="sm" variant="outline" onClick={() => { setError(null); setAttempt(n => n + 1); }}>{t('linkedFile.retry')}</Button>
      </div> : !file ? <div role="status" className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />{t('linkedFile.loading')}
      </div> : <>
        {file.truncated && !file.isBinary && !mediaFile && <p className="mb-2 text-xs text-muted-foreground">{t('linkedFile.truncated')}</p>}
        {file.imageType ? <img src={'data:' + file.imageType + ';base64,' + file.content} alt={file.path} className="mx-auto max-h-[60vh] max-w-full object-contain" />
          : file.isBinary || mediaFile ? <p>{t('linkedFile.binary')}</p>
          : !file.content ? <p>{t('linkedFile.empty')}</p>
          : /\.(md|markdown|mdown)$/i.test(file.path) && !link.line ?
            <ChatFileLinkContext.Provider value={{ open: follow, sourceFile: file.absolutePath }}>
              <Markdown text={file.content} initialAnchor={link.fragment} showDocumentCopy={false} />
            </ChatFileLinkContext.Provider>
          : <SourcePreview content={file.content} line={link.line} />}
      </>}
    </div>
    {(back || canCopy || canOpenEditor) && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t pt-2">
      {back && <Button className="mr-auto" size="sm" variant="ghost" onClick={back}><ArrowLeft className="mr-1 h-4 w-4" />{t('linkedFile.back')}</Button>}
      {canCopy && <Button asChild size="sm" variant="outline">
        <CopyTextButton text={file.content} label={file.truncated ? t('linkedFile.copyPreview') : t('linkedFile.copyContent')} />
      </Button>}
      {canOpenEditor && <Button size="sm" variant="outline" onClick={() => {
        if (link.line) navigateToProjectLocation({ projectId: workspaceId, path: file.path, line: link.line, column: link.column ?? 1 });
        else useWorkspaceStore.getState().openFile({ projectId: workspaceId, path: file.path, content: null, dirty: false, lastModified: null });
        window.dispatchEvent(new CustomEvent('mcp:open-files-tab', { detail: { projectId: workspaceId } }));
        close();
      }}><FileCode2 className="mr-1 h-4 w-4" />{t('linkedFile.editor')}</Button>}
    </div>}
  </>;
}

function SourcePreview({ content, line }: { content: string; line?: number }) {
  const selected = useRef<HTMLElement>(null);
  const start = useMemo(() => {
    if (!line) return -1;
    let offset = 0;
    for (let i = 1; i < line; i++) {
      const next = content.indexOf('\n', offset);
      if (next === -1) return -1;
      offset = next + 1;
    }
    return offset;
  }, [content, line]);
  const newline = start < 0 ? -1 : content.indexOf('\n', start);
  const end = newline === -1 ? content.length : newline;
  useEffect(() => { selected.current?.scrollIntoView({ block: 'center' }); }, [line, content]);
  return <pre className="min-w-fit font-mono text-xs leading-5" tabIndex={0}>{start < 0 ? content : <>
    {content.slice(0, start)}<mark ref={selected}>{content.slice(start, end) || ' '}</mark>{content.slice(end)}
  </>}</pre>;
}
