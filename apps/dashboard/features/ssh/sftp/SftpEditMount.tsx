/**
 * In-editor SFTP file editor. Opened by the SFTP browser's "edit" action: the
 * remote file's bytes are fetched into a Monaco model (no temp file on disk),
 * Ctrl+S re-uploads over SFTP, and closing the tab disposes the model — the
 * whole download → edit → upload → discard cycle the user expects, but with the
 * content living only in memory.
 *
 * Self-contained like MergeTabView: it owns its `<Editor>` and registers the
 * model + a save closure with `sftp-edit-session`, which the global `file.save`
 * command routes to and whose janitor disposes the model on tab close. The save
 * closure captures the MODEL (not the editor) so an inactive remote tab still
 * saves via Save-All.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as MonacoNs from 'monaco-editor';
import { useTranslation } from 'react-i18next';
import { languageIdForPath as inferLanguage } from '@mcp/shared/utils/language-id.js';
import { useWorkspaceStore, type OpenSftpFile } from '../../../state/workspace.js';
import { toast } from '../../../components/ui/prompt-dialog.js';
import { registerSftpEdit } from '../../workspace/editor/sftp-edit-session.js';
import { sftpWriteFile } from '../api.js';

function detectDark(): boolean {
  if (typeof document === 'undefined') return true;
  return document.documentElement.classList.contains('dark');
}

const baseName = (p: string): string => p.split('/').pop() || p;

/** Stable, collision-free Monaco model URI for a remote-edit tab. */
function sftpModelPath(projectId: number, path: string): string {
  return `sftp:${projectId}:${encodeURIComponent(path)}`;
}

export function SftpEditMount({ tab }: { tab: OpenSftpFile }) {
  const { t } = useTranslation('ssh');
  const tRef = useRef(t);
  tRef.current = t;
  const setSftpDirty = useWorkspaceStore((s) => s.setSftpDirty);
  const markSftpSaved = useWorkspaceStore((s) => s.markSftpSaved);

  const editorRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null);
  // Last-saved baseline for dirty detection. Synced when a save lands (which
  // updates tab.content) so typing back to the saved text clears the dot.
  const lastSavedRef = useRef(tab.content);
  useEffect(() => {
    lastSavedRef.current = tab.content;
  }, [tab.content]);

  const language = inferLanguage(tab.remotePath);
  const dark = detectDark();
  const modelPath = sftpModelPath(tab.projectId, tab.path);

  const handleMount = useCallback<OnMount>(
    (editor, monaco) => {
      editorRef.current = editor;
      const model = editor.getModel();
      if (model) {
        // Save closure binds the MODEL (survives tab switches) + the stable tab.
        const save = async (): Promise<boolean> => {
          const value = model.getValue();
          try {
            await sftpWriteFile(tab.spec, tab.remotePath, value);
            lastSavedRef.current = value;
            markSftpSaved(tab.projectId, tab.path, value);
            // Edits made DURING a slow upload moved the model past `value` — keep
            // the tab dirty so that delta isn't silently treated as saved (and
            // lost on close).
            if (model.getValue() !== value) setSftpDirty(tab.projectId, tab.path, true);
            toast.success(tRef.current('sftp.editSaved', { name: baseName(tab.remotePath) }));
            return true;
          } catch (e) {
            toast.error(tRef.current('sftp.editSaveFailed'), {
              description: e instanceof Error ? e.message : String(e),
            });
            return false;
          }
        };
        registerSftpEdit(tab.projectId, tab.path, { model, save });
      }
      // Theme baked at create; track runtime light/dark toggles.
      monaco.editor.setTheme(detectDark() ? 'vs-dark' : 'vs');
      editor.focus();
    },
    // tab identity is stable per mount; store actions are stable refs.
    [tab.projectId, tab.path, tab.remotePath, tab.spec, markSftpSaved, setSftpDirty],
  );

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (value === undefined) return; // model swap, not a real edit
      setSftpDirty(tab.projectId, tab.path, value !== lastSavedRef.current);
    },
    [tab.projectId, tab.path, setSftpDirty],
  );

  const options = useMemo<MonacoNs.editor.IStandaloneEditorConstructionOptions>(
    () => ({
      automaticLayout: true,
      fontSize: 13,
      fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, "Liberation Mono", Menlo, monospace',
      fontLigatures: true,
      lineHeight: 1.55,
      minimap: { enabled: true, renderCharacters: false, showSlider: 'mouseover' },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      tabSize: 2,
      bracketPairColorization: { enabled: true },
      padding: { top: 8, bottom: 8 },
      // No project FS / LSP here — keep word-based suggestions for basic help.
      wordBasedSuggestions: 'currentDocument',
    }),
    [],
  );

  return (
    <div className="h-full flex flex-col min-h-0 bg-background">
      <div className="shrink-0 h-7 px-3 border-b flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-mono truncate" title={`${tab.hostLabel}:${tab.remotePath}`}>
          {tab.hostLabel}:{tab.remotePath}
        </span>
        <span className="ml-auto shrink-0 opacity-70">{t('sftp.editHint')}</span>
      </div>
      <div className="flex-1 min-h-0 relative">
        <Editor
          height="100%"
          width="100%"
          path={modelPath}
          defaultValue={tab.content}
          keepCurrentModel
          defaultLanguage={language}
          language={language}
          theme={dark ? 'vs-dark' : 'vs'}
          onMount={handleMount}
          onChange={handleChange}
          options={options}
        />
      </div>
    </div>
  );
}
