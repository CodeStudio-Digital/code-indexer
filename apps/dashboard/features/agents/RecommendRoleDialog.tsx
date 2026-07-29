/**
 * RecommendRoleDialog — wraps the role-recommendation pipeline as a
 * dialog with a free-form task input + ranked-list output. Reusable from
 * anywhere in the dashboard (kanban toolbar, master chat, session header).
 *
 * Surfaces:
 *   - taskAffinity: cosine similarity task ↔ role (driven by embeddings)
 *   - historySuccess: rolling success rate for (role, task_class)
 *   - modelCost: normalized cost (lower better, weight is negative)
 *   - reuseBonus: 1.0 when the row is `kind=reuse` (an idle subordinate)
 *
 * The dialog is read-only — clicking on a row doesn't auto-spawn anything.
 * That's intentional: the master/operator decides what to do with the
 * recommendation.
 */
import { useState } from 'react';
import { Loader2, Sparkles, RefreshCcw } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Textarea } from '../../components/ui/textarea.js';
import {
  recommendRole,
  type RoleRecommendation,
} from './recommendations-api.js';

interface Props {
  sessionId: string;
  open: boolean;
  onClose: () => void;
  /** Optional initial task text (e.g. picked from a kanban card). */
  initialTask?: string;
}

export function RecommendRoleDialog({ sessionId, open, onClose, initialTask = '' }: Props) {
  const [task, setTask] = useState(initialTask);
  const [recommendations, setRecommendations] = useState<RoleRecommendation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastDuration, setLastDuration] = useState<number | null>(null);

  async function onRun() {
    if (!task.trim()) {
      setError('Task text is required');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await recommendRole(sessionId, task.trim(), 5);
      setRecommendations(result.recommendations);
      setLastDuration(result.durationMs);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-amber-400" />
            Recommend role for this task
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div>
            <label className="text-xs font-medium block mb-1">Task description</label>
            <Textarea
              rows={3}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="e.g. Fix the React state bug in the login flow"
              autoFocus
            />
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={() => void onRun()} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCcw className="h-4 w-4 mr-1" />}
              Get recommendations
            </Button>
            {lastDuration != null && (
              <span className="text-xs text-muted-foreground">Resolved in {Math.round(lastDuration)}ms</span>
            )}
          </div>

          {error && <div className="text-sm text-red-500">{error}</div>}

          {recommendations && (
            <div className="space-y-2 pt-2 border-t">
              {recommendations.length === 0 && (
                <div className="text-sm text-muted-foreground italic">
                  No candidates — does this session have a template with roles configured?
                </div>
              )}
              {recommendations.map((r, idx) => (
                <div
                  key={`${r.role}-${idx}`}
                  className="flex items-center gap-3 p-2 rounded border bg-muted/30 text-sm"
                >
                  <span className="font-mono w-6 text-muted-foreground text-xs">#{idx + 1}</span>
                  <span className="font-semibold">{r.role}</span>
                  <Badge variant={r.kind === 'reuse' ? 'default' : 'outline'} className="text-xs">
                    {r.kind === 'reuse' ? `reuse #${r.agentRunId}` : 'fresh spawn'}
                  </Badge>
                  <div className="flex-1" />
                  <div className="flex items-center gap-1 text-xs text-muted-foreground" title={signalsTooltip(r)}>
                    {r.signals.taskAffinity != null && (
                      <span className="font-mono">
                        sim {r.signals.taskAffinity.toFixed(2)}
                      </span>
                    )}
                  </div>
                  <Badge className="font-mono">{r.score.toFixed(3)}</Badge>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function signalsTooltip(r: RoleRecommendation): string {
  const parts: string[] = [];
  if (r.signals.taskAffinity != null)   parts.push(`taskAffinity=${r.signals.taskAffinity.toFixed(3)}`);
  if (r.signals.historySuccess != null) parts.push(`historySuccess=${r.signals.historySuccess.toFixed(2)}`);
  if (r.signals.modelCost != null)      parts.push(`modelCost=${r.signals.modelCost.toFixed(2)}`);
  if (r.signals.reuseBonus != null)     parts.push(`reuseBonus=${r.signals.reuseBonus.toFixed(0)}`);
  return parts.join('\n');
}
