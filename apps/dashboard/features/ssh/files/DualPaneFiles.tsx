/**
 * Dual-pane file manager (FileZilla/WinSCP-style) — the SSH "Arquivos" view.
 * LEFT = the project's local files, RIGHT = the selected host's SFTP files.
 * A shared transfer controller moves files between the two panes' current dirs
 * (buttons, context menu, or drag-and-drop); a draggable divider resizes them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import type { SshHost, SshIdentity } from '../types.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select.js';
import { apiCall } from '../../../lib/api-client.js';
import { toast } from '../../../components/ui/prompt-dialog.js';
import { useWorkspaceStore } from '../../../state/workspace.js';
import { useWorkspaceLayout } from '../../../state/workspace-layout.js';
import { findHostByKey, sftpReadFile, sshHostKey, type NeedTrust } from '../api.js';
import { createLocalAdapter } from './local-adapter.js';
import { createPaneSelection } from './pane-selection.js';
import { useRemoteHost } from './use-remote-host.js';
import { useTransfers } from './transfer-controller.js';
import { FilePane } from './FilePane.js';
import { useColumnConfig } from './column-config.js';
import { TransferBar } from './TransferBar.js';
import { ConflictDialogHost } from './conflict-dialog.js';
import { extractLocal, extractRemote, zipLocal, zipRemote } from './zip-actions.js';
import type { FsItem } from './fs-adapter.js';

interface DualPaneFilesProps {
  projectId: number;
  hosts: SshHost[];
  identities: SshIdentity[];
  onNeedTrust: NeedTrust;
}

type Kind = 'local' | 'remote';

export function DualPaneFiles({ projectId, hosts, identities, onNeedTrust }: DualPaneFilesProps) {
  const { t } = useTranslation('ssh');
  const [hostId, setHostId] = useState('');
  const [rootPath, setRootPath] = useState<string | null>(null);
  useEffect(() => {
    setRootPath(null);
    void apiCall<{ root_path?: string }>('projects.get', { id: projectId })
      .then((p) => setRootPath(p.root_path ?? null))
      .catch(() => setRootPath(null));
  }, [projectId]);

  const localSel = useMemo(() => createPaneSelection(), []);
  const remoteSel = useMemo(() => createPaneSelection(), []);
  const localAdapter = useMemo(() => (rootPath != null ? createLocalAdapter(projectId, rootPath) : null), [projectId, rootPath]);
  const { spec, adapter: remoteAdapter, error: remoteError, connecting } = useRemoteHost(hostId, hosts, identities, onNeedTrust);
  // Shared column config across both panes so the layout stays symmetric.
  const { visibility: columns, widths: columnWidths, toggle: onToggleColumn, setWidth: onColumnWidthChange } = useColumnConfig();
  const { transfers, transferItems, cancel } = useTransfers(spec);

  const [localCwd, setLocalCwd] = useState('');
  const [remoteCwd, setRemoteCwd] = useState('/');
  const [localRefresh, setLocalRefresh] = useState(0);
  const [remoteRefresh, setRemoteRefresh] = useState(0);

  const runTransfer = useCallback(
    async (from: Kind, to: Kind, destDir: string, items: FsItem[]) => {
      if (!localAdapter || !remoteAdapter) return;
      const src = from === 'local' ? localAdapter : remoteAdapter;
      const dest = to === 'local' ? localAdapter : remoteAdapter;
      const did = await transferItems(src, dest, destDir, items);
      if (did) (to === 'local' ? setLocalRefresh : setRemoteRefresh)((n) => n + 1);
    },
    [localAdapter, remoteAdapter, transferItems],
  );

  // Open a remote file in Monaco (in-memory edit → re-upload on save); local
  // files open as normal project tabs. Both collapse the bottom panel so the
  // freshly opened file takes the editor area.
  const editRemote = useCallback(
    async (item: FsItem) => {
      if (!spec) return;
      try {
        const { content } = await sftpReadFile(spec, item.path);
        const host = findHostByKey(hosts, hostId);
        useWorkspaceStore.getState().openSftpFile({
          kind: 'sftp',
          projectId,
          path: `sftp:${spec.hostId}:${item.path}`,
          remotePath: item.path,
          spec,
          hostLabel: host?.label ?? spec.host,
          content,
          dirty: false,
        });
        useWorkspaceLayout.getState().setActiveBottom(null);
      } catch (e) {
        toast.error(t('sftp.editError', { name: item.name, reason: e instanceof Error ? e.message : String(e) }));
      }
    },
    [spec, hosts, hostId, projectId, t],
  );

  const openLocal = useCallback(
    (item: FsItem) => {
      useWorkspaceStore.getState().openFile({ projectId, path: item.path, content: null, dirty: false, lastModified: null });
      useWorkspaceLayout.getState().setActiveBottom(null);
    },
    [projectId],
  );

  const localZip = useCallback((cwd: string, names: string[]) => (localAdapter ? zipLocal(projectId, cwd, names, localAdapter.join, t) : Promise.resolve(false)), [localAdapter, projectId, t]);
  const localExtract = useCallback((cwd: string, name: string) => (localAdapter ? extractLocal(projectId, cwd, name, localAdapter.join, t) : Promise.resolve(false)), [localAdapter, projectId, t]);
  const remoteZip = useCallback((cwd: string, names: string[]) => (spec ? zipRemote(spec, cwd, names, t) : Promise.resolve(false)), [spec, t]);
  const remoteExtract = useCallback((cwd: string, name: string) => (spec ? extractRemote(spec, cwd, name, t) : Promise.resolve(false)), [spec, t]);

  // Draggable divider.
  const containerRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(0.5);
  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => setRatio(Math.min(0.8, Math.max(0.2, (ev.clientX - rect.left) / rect.width)));
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="h-8 shrink-0 border-b flex items-center gap-2 px-2">
        <div className="w-[200px] shrink-0">
          <Select value={hostId} onValueChange={setHostId}>
            <SelectTrigger className="h-6 text-xs">
              <SelectValue placeholder={t('sftp.selectHost')} />
            </SelectTrigger>
            <SelectContent>
              {hosts.map((h) => (
                <SelectItem key={sshHostKey(h)} value={sshHostKey(h)}>
                  {h.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {connecting && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        {remoteError && <span className="text-[10px] text-red-400 truncate" title={remoteError}>{remoteError}</span>}
      </div>

      <div ref={containerRef} className="flex-1 min-h-0 flex">
        <div style={{ width: `${ratio * 100}%` }} className="min-w-0 border-r flex flex-col">
          {localAdapter ? (
            <FilePane
              adapter={localAdapter}
              useSel={localSel}
              otherKind="remote"
              otherCwd={remoteCwd}
              refreshKey={localRefresh}
              onCwdChange={setLocalCwd}
              onTransfer={runTransfer}
              onOpenFile={openLocal}
              onZip={localZip}
              onExtract={localExtract}
              columns={columns}
              columnWidths={columnWidths}
              onToggleColumn={onToggleColumn}
              onColumnWidthChange={onColumnWidthChange}
            />
          ) : (
            <div className="grid place-items-center h-full text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          )}
        </div>
        <div className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-primary/50" onMouseDown={startDrag} />
        <div className="flex-1 min-w-0 flex flex-col">
          {remoteAdapter ? (
            <FilePane
              adapter={remoteAdapter}
              useSel={remoteSel}
              otherKind="local"
              otherCwd={localCwd}
              refreshKey={remoteRefresh}
              onCwdChange={setRemoteCwd}
              onTransfer={runTransfer}
              onOpenFile={editRemote}
              onZip={remoteZip}
              onExtract={remoteExtract}
              columns={columns}
              columnWidths={columnWidths}
              onToggleColumn={onToggleColumn}
              onColumnWidthChange={onColumnWidthChange}
            />
          ) : (
            <div className="grid place-items-center h-full text-xs text-muted-foreground">{t('sftp.selectHost')}</div>
          )}
        </div>
      </div>

      <TransferBar transfers={transfers} onCancel={cancel} />
      <ConflictDialogHost />
    </div>
  );
}
