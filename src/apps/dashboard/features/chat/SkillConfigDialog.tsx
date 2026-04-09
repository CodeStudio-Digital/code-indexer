import { useCallback, useEffect, useState } from 'react';
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
  sessionId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const MODE_LABEL: Record<string, string> = {
  inline: 'Inline',
  tool: 'Tool',
  both: 'Both',
};

export function SkillConfigDialog({ sessionId, open, onOpenChange }: SkillConfigDialogProps) {
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
    if (open && sessionId) void load();
  }, [open, sessionId, load]);

  const toggle = async (skillId: string, enabled: boolean) => {
    if (!sessionId) return;
    await fetch(`/api/coder/sessions/${sessionId}/skills/${skillId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    // Optimistic update
    setSkills((prev) =>
      prev.map((s) =>
        s.id === skillId ? { ...s, session_enabled: enabled, is_active: enabled } : s,
      ),
    );
    setActiveCount((prev) => prev + (enabled ? 1 : -1));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            Session Skills
          </DialogTitle>
          <DialogDescription>
            Enable or disable skills for this session. Changes take effect on the next message.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="text-sm text-muted-foreground py-4">Loading...</div>
        ) : skills.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4 text-center">
            No skills configured. Go to Admin &gt; Skills to create some.
          </div>
        ) : (
          <>
            <div className="text-xs text-muted-foreground">
              Active: <strong className="text-foreground">{activeCount}</strong> / {skills.length}
            </div>
            <div className="flex-1 overflow-auto space-y-1 -mx-2 px-2">
              {skills.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50 gap-2"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium truncate">{s.name}</span>
                      <Badge variant="outline" className="h-4 text-[10px] shrink-0">
                        {MODE_LABEL[s.context_mode] ?? s.context_mode}
                      </Badge>
                      {s.slash_command && (
                        <Badge variant="secondary" className="h-4 text-[10px] font-mono shrink-0">
                          /{s.slash_command}
                        </Badge>
                      )}
                      {s.source === 'builtin' && (
                        <Badge variant="secondary" className="h-4 text-[10px] shrink-0">
                          builtin
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
      </DialogContent>
    </Dialog>
  );
}
