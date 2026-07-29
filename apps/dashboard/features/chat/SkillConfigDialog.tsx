import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Switch } from '../../components/ui/switch.js';

interface SessionSkill {
  id: string;
  name: string;
  description: string;
  slash_command: string | null;
  context_mode: string;
  enabled: boolean;
  scope: string;
  tags: string[];
  source: string;
  session_enabled: boolean;
  is_active: boolean;
}

interface SkillConfigDialogProps {
  sessionId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Headless body of the skill-config surface — list + per-row toggle.
 * Used by both the legacy `SkillConfigDialog` (modal) and the new
 * `SkillConfigPanel` (right-rail). The body owns its own fetch lifecycle
 * keyed off `sessionId` and an explicit `loadKey` (bumped to force a
 * refetch when the panel mounts/visibility changes).
 */
export function SkillConfigView({
  sessionId,
  loadKey = 0,
  showDescription = true,
}: {
  sessionId: string | null;
  loadKey?: number;
  showDescription?: boolean;
}) {
  const { t } = useTranslation(['chat', 'common']);
  const [skills, setSkills] = useState<SessionSkill[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/coder/sessions/${sessionId}/skills`);
      const data = (await r.json()) as { skills: SessionSkill[]; active_count: number };
      setSkills(data.skills);
      setActiveCount(data.active_count);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (sessionId) void load();
  }, [sessionId, loadKey, load]);

  const toggle = async (skillId: string, enabled: boolean) => {
    if (!sessionId) return;
    await fetch(`/api/coder/sessions/${sessionId}/skills/${skillId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    void load();
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {showDescription && (
        <div className="px-3 py-2 border-b text-[11px] text-muted-foreground shrink-0">
          {t('chat:skillConfig.description')}
        </div>
      )}
      {loading ? (
        <div className="text-sm text-muted-foreground py-4 px-3">{t('common:actions.loading')}</div>
      ) : skills.length === 0 ? (
        <div className="text-sm text-muted-foreground py-4 px-3 text-center">
          {t('chat:skillConfig.noSkills')}
        </div>
      ) : (
        <>
          <div className="px-3 py-1.5 text-[11px] text-muted-foreground shrink-0">
            {t('chat:skillConfig.active', { count: activeCount })} / {skills.length}
          </div>
          <div className="flex-1 overflow-auto space-y-1 px-2 pb-2">
            {skills.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50 gap-2"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium truncate">{s.name}</span>
                    <Badge variant="outline" className="h-4 text-[10px] shrink-0">
                      {t(`chat:skillConfig.${s.context_mode}`, { defaultValue: s.context_mode })}
                    </Badge>
                    {s.slash_command && (
                      <Badge variant="secondary" className="h-4 text-[10px] font-mono shrink-0">
                        /{s.slash_command}
                      </Badge>
                    )}
                    {s.source === 'builtin' && (
                      <Badge variant="secondary" className="h-4 text-[10px] shrink-0">
                        {t('chat:skillConfig.builtin')}
                      </Badge>
                    )}
                  </div>
                  {s.description && (
                    <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                      {s.description}
                    </div>
                  )}
                </div>
                <Switch
                  checked={s.session_enabled}
                  onCheckedChange={(v) => void toggle(s.id, v)}
                  className="shrink-0"
                />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function SkillConfigDialog({ sessionId, open, onOpenChange }: SkillConfigDialogProps) {
  const { t } = useTranslation(['chat']);
  // Force a refetch each time the dialog opens by incrementing a load
  // key — the view treats sessionId+loadKey as the dependency.
  const [loadKey, setLoadKey] = useState(0);
  useEffect(() => {
    if (open) setLoadKey((k) => k + 1);
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            {t('chat:skillConfig.title')}
          </DialogTitle>
          <DialogDescription>{t('chat:skillConfig.description')}</DialogDescription>
        </DialogHeader>
        <SkillConfigView sessionId={sessionId} loadKey={loadKey} showDescription={false} />
      </DialogContent>
    </Dialog>
  );
}
