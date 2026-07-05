/**
 * Editor tab strip (multi-tab editor). One tab per open IMAGE (version, or a
 * new asset's blank doc); clicking focuses it, × / middle-click closes it. A
 * dot marks unsaved edits (engine.isDirty — cleared by save, restored by
 * undoing past the save mark). The active tab is the studio's current
 * asset+version. Horizontally scrollable, Photoshop-style.
 */
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { engineKey, peekEngine } from '../engine/engine-registry.js';
import { useSpriteEditorStore } from '../store/editor-store.js';
import { useEditorTabs, type EditorTab } from './editor-tabs.js';

export function EditorTabBar({
  projectId,
  activeKey,
  onFocus,
  onClose,
}: {
  projectId: number;
  /** The active tab's key (editorTabKey of the current asset+version). */
  activeKey: string | null;
  onFocus: (tab: EditorTab) => void;
  onClose: (tab: EditorTab) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const tabs = useEditorTabs((s) => s.tabs);
  // Subscribing to the ACTIVE engine's dirty flag keeps the dots fresh:
  // inactive engines can't change (no input reaches them), so re-rendering on
  // active-dirty transitions is sufficient to re-poll every tab.
  useSpriteEditorStore((s) => s.dirty);
  if (tabs.length === 0) return null;
  return (
    <div className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b bg-card/30">
      {tabs.map((tab) => {
        const active = tab.key === activeKey;
        const dirty = peekEngine(engineKey(projectId, tab.assetId, tab.versionId))?.isDirty === true;
        return (
          <div
            key={tab.key}
            className={cn(
              'group/tab relative flex shrink-0 items-center gap-1 border-r pl-2 pr-1 text-[11px] transition-colors',
              active ? 'bg-background text-foreground' : 'text-muted-foreground hover:bg-muted/40',
            )}
            // Middle-click closes (standard tab-strip gesture).
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(tab); } }}
          >
            <button
              type="button"
              onClick={() => onFocus(tab)}
              className="flex max-w-[180px] items-center gap-1.5 truncate py-1"
              title={dirty ? `${tab.label} · ${t('editor.unsaved')}` : tab.label}
            >
              {dirty && (
                <span
                  aria-label={t('editor.unsaved')}
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                />
              )}
              <span className="truncate">{tab.label}</span>
            </button>
            <button
              type="button"
              onClick={() => onClose(tab)}
              aria-label={t('editor.closeTab')}
              title={t('editor.closeTab')}
              className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground',
                active ? 'opacity-100' : 'opacity-0 group-hover/tab:opacity-100',
              )}
            >
              <X className="h-3 w-3" />
            </button>
            {active && <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-primary" />}
          </div>
        );
      })}
    </div>
  );
}
