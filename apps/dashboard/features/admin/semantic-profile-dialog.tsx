import { probeSemanticTarget, saveSemanticProfile, type SemanticProbeResult, type SemanticProfileView, type SemanticTarget } from './semantic-api.js';
import type { AdminProvider } from './types.js';
import { useTranslation } from 'react-i18next';
import { useMemo, useState } from 'react';
import { confirm as confirmDialog } from '../../components/ui/prompt-dialog.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert.js';
import { AlertCircle, CheckCircle2, Loader2, Save, Sparkles, XCircle } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { targetIsComplete } from './semantic-indexing-format.js';
import { TargetEditor } from './semantic-target-editor.js';

interface ProfileDialogProps {
  profile: SemanticProfileView;
  providers: AdminProvider[];
  onClose: () => void;
  onSaved: (profile: SemanticProfileView) => void;
}

type ProbeState =
  | { status: 'idle' | 'testing' }
  | {
      status: 'success';
      signature: string;
      results: Array<{ capability: 'embedding' | 'rerank'; result: SemanticProbeResult }>;
    }
  | { status: 'error'; message: string };

export function ProfileDialog({ profile, providers, onClose, onSaved }: ProfileDialogProps) {
  const { t } = useTranslation(['admin', 'common']);
  const [embeddingTarget, setEmbeddingTarget] = useState<SemanticTarget>(profile.embedding_target);
  const [rerankerTarget, setRerankerTarget] = useState<SemanticTarget>(profile.reranker_target);
  const [probe, setProbe] = useState<ProbeState>({ status: 'idle' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const signature = useMemo(
    () => JSON.stringify({ embedding_target: embeddingTarget, reranker_target: rerankerTarget }),
    [embeddingTarget, rerankerTarget],
  );
  const complete = targetIsComplete(embeddingTarget) && targetIsComplete(rerankerTarget);
  const probeCurrent = probe.status === 'success' && probe.signature === signature;

  const usesHeavyFp32 = [embeddingTarget, rerankerTarget].some(
    (target) => target.kind === 'onnx' && target.dtype === 'fp32',
  );

  function confirmHeavyFp32(): Promise<boolean> {
    if (!usesHeavyFp32) return Promise.resolve(true);
    return confirmDialog({
      title: t('semantic.form.fp32Warning'),
      description: t('semantic.actions.fp32Confirm'),
      confirmLabel: t('common:actions.confirm'),
      tone: 'destructive',
    });
  }

  function changeEmbedding(target: SemanticTarget) {
    setEmbeddingTarget(target);
    setProbe({ status: 'idle' });
  }

  function changeReranker(target: SemanticTarget) {
    setRerankerTarget(target);
    setProbe({ status: 'idle' });
  }

  async function runProbe() {
    if (!(await confirmHeavyFp32())) return;
    setProbe({ status: 'testing' });
    setSaveError(null);
    try {
      const targets: Array<{
        capability: 'embedding' | 'rerank';
        target: SemanticTarget;
      }> = [];
      if (embeddingTarget.kind !== 'disabled') {
        targets.push({ capability: 'embedding', target: embeddingTarget });
      }
      if (rerankerTarget.kind !== 'disabled') {
        targets.push({ capability: 'rerank', target: rerankerTarget });
      }
      const results: Array<{
        capability: 'embedding' | 'rerank';
        result: SemanticProbeResult;
      }> = [];
      // Probe one local model at a time. Running embedder and reranker probes
      // concurrently can briefly double ONNX memory usage.
      for (const { capability, target } of targets) {
        results.push({
          capability,
          result: await probeSemanticTarget(capability, target, usesHeavyFp32),
        });
      }
      const failed = results.find(({ result }) => !result.ok);
      if (failed) throw new Error(failed.result.error ?? t('semantic.probe.failed'));
      setProbe({ status: 'success', signature, results });
    } catch (error) {
      setProbe({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function save() {
    if (!probeCurrent) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await saveSemanticProfile(profile.purpose, {
        embedding_target: embeddingTarget,
        reranker_target: rerankerTarget,
      }, usesHeavyFp32);
      onSaved(saved);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {t('semantic.dialog.title', { purpose: t(`semantic.purpose.${profile.purpose}.title`) })}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <TargetEditor
            capability="embedding"
            target={embeddingTarget}
            providers={providers}
            onChange={changeEmbedding}
          />
          <TargetEditor
            capability="rerank"
            target={rerankerTarget}
            providers={providers}
            onChange={changeReranker}
          />

          {!complete && (
            <Alert variant="warning">
              <AlertCircle />
              <AlertTitle>{t('semantic.validation.title')}</AlertTitle>
              <AlertDescription>{t('semantic.validation.incomplete')}</AlertDescription>
            </Alert>
          )}

          {probe.status === 'success' && probeCurrent && (
            <Alert variant="success">
              <CheckCircle2 />
              <AlertTitle>{t('semantic.probe.successTitle')}</AlertTitle>
              <AlertDescription>
                {probe.results.length === 0
                  ? t('semantic.probe.disabledTargets')
                  : probe.results
                      .map(({ capability, result }) =>
                        t('semantic.probe.result', {
                          capability: t(`semantic.capability.${capability}.title`),
                          latency: result.latency_ms ?? 0,
                          dimensions: result.dimensions ?? '—',
                        }),
                      )
                      .join(' · ')}
              </AlertDescription>
            </Alert>
          )}

          {probe.status === 'error' && (
            <Alert variant="destructive">
              <XCircle />
              <AlertTitle>{t('semantic.probe.errorTitle')}</AlertTitle>
              <AlertDescription>{probe.message}</AlertDescription>
            </Alert>
          )}

          {saveError && (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>{t('semantic.save.errorTitle')}</AlertTitle>
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <p className="mr-auto max-w-sm text-xs text-muted-foreground">
            {probeCurrent ? t('semantic.probe.current') : t('semantic.probe.required')}
          </p>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="outline" onClick={() => void runProbe()} disabled={!complete || probe.status === 'testing'}>
            {probe.status === 'testing' ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-4 w-4" />
            )}
            {t('semantic.probe.action')}
          </Button>
          <Button onClick={() => void save()} disabled={!probeCurrent || saving}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            {t('common:actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
