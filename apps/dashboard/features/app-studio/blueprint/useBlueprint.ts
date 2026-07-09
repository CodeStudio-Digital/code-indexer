/**
 * Cérebro do canvas Blueprint: draft da spec + layout + dirty/conflito e
 * as duas saídas (Salvar direto quando o discovery está destravado;
 * "Aplicar mudanças" = reopen → PUT spec → PUT layout → mensagem de
 * reconcile pro agente quando travado).
 *
 * Regras duras contra o polling de 5s do detail:
 *  - dirty ⇒ o detail NUNCA re-seeda o draft;
 *  - conflito = spec do servidor mudou sob nossos pés (baseline difere) —
 *    banner com escolha explícita (recarregar/perder), sem merge.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { parseAppSpec, type AppSpec } from '@mcp/app-studio/spec/types.js';
import { validateAppSpec } from '@mcp/app-studio/spec/validate.js';
import { applySpecMutation, type BlueprintMutation } from '@mcp/app-studio/blueprint/mutations.js';
import { parseBlueprintLayout, type BlueprintLayout, type BlueprintPosition } from '@mcp/app-studio/blueprint/types.js';
import { diffSpec, formatDiffSummary, type DiffKind } from '@mcp/app-studio/blueprint/diff-summary.js';
import { confirm } from '../../../components/ui/prompt-dialog.js';
import { requestStudioSend } from '../../builder/studio/studio-context-store.js';
import { patchAppStage, type AppStudioSessionDetail } from '../app-studio-api.js';
import { putAppSpec, putBlueprintLayout } from './blueprint-api.js';

const LAYOUT_DEBOUNCE_MS = 800;
const EMPTY_LAYOUT: BlueprintLayout = { v: 1, positions: {} };

export function useBlueprint(detail: AppStudioSessionDetail, t: TFunction, refresh: () => void) {
  const sessionId = detail.session.id;
  const projectId = detail.project?.id ?? detail.session.project_id;
  const [draft, setDraft] = useState<AppSpec | null>(null);
  const [layout, setLayout] = useState<BlueprintLayout>(EMPTY_LAYOUT);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const baselineRef = useRef<string | null>(null);
  const layoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Seed/re-seed a partir do servidor — NUNCA com dirty (regra dura).
  const serverSpecJson = detail.session.spec_json;
  useEffect(() => {
    if (dirty) {
      if (serverSpecJson !== baselineRef.current) setConflict(true);
      return;
    }
    baselineRef.current = serverSpecJson;
    setDraft(parseAppSpec(serverSpecJson));
    setConflict(false);
  }, [serverSpecJson, dirty]);

  // Layout: seed 1x por sessão (edições locais têm precedência depois).
  const layoutSeeded = useRef<number | null>(null);
  useEffect(() => {
    if (layoutSeeded.current === sessionId) return;
    layoutSeeded.current = sessionId;
    setLayout(parseBlueprintLayout(detail.session.blueprint_json ?? null) ?? EMPTY_LAYOUT);
  }, [sessionId, detail.session.blueprint_json]);

  /** Aplica uma mutação; cascades pedem confirmação listando o que sai. */
  const mutate = useCallback(
    async (m: BlueprintMutation): Promise<boolean> => {
      if (!draft) return false;
      let result;
      try {
        result = applySpecMutation(draft, m);
      } catch (e) {
        setIssues([(e as Error).message]);
        return false;
      }
      if (result.cascaded.length > 0) {
        const go = await confirm({
          title: t('blueprint.cascadeTitle'),
          description: `${t('blueprint.cascadeBody')}\n\n• ${result.cascaded.join('\n• ')}`,
          confirmLabel: t('blueprint.cascadeConfirm'),
        });
        if (!go) return false;
      }
      setDraft(result.spec);
      setDirty(true);
      setIssues(validateAppSpec(result.spec));
      return true;
    },
    [draft, t],
  );

  /** Drag do nó → layout local + PUT debounced (independente do dirty). */
  const setNodePosition = useCallback(
    (nodeId: string, position: BlueprintPosition) => {
      setLayout((prev) => {
        const next = { ...prev, positions: { ...prev.positions, [nodeId]: position } };
        if (layoutTimer.current) clearTimeout(layoutTimer.current);
        layoutTimer.current = setTimeout(() => {
          void putBlueprintLayout(sessionId, next).catch(() => {});
        }, LAYOUT_DEBOUNCE_MS);
        return next;
      });
    },
    [sessionId],
  );

  const discoveryApproved =
    detail.pipeline?.stages.find((s) => s.id === 'discovery')?.status === 'approved';

  /** Salvar (destravado) OU aplicar com reopen+reconcile (travado). */
  const save = useCallback(async (): Promise<void> => {
    if (!draft || busy) return;
    const baseline = parseAppSpec(baselineRef.current);
    setBusy(true);
    try {
      if (discoveryApproved) {
        const kindLabels = Object.fromEntries(
          (['screen', 'entity', 'feature', 'behavior', 'auth'] as DiffKind[]).map((k) => [
            k,
            t(`blueprint.kind.${k}`),
          ]),
        ) as Record<DiffKind, string>;
        const summary = baseline ? formatDiffSummary(diffSpec(baseline, draft), kindLabels) : '';
        const go = await confirm({
          title: t('blueprint.applyTitle'),
          description: `${t('blueprint.applyBody')}${summary ? `\n\n${summary}` : ''}`,
          confirmLabel: t('blueprint.applyConfirm'),
        });
        if (!go) return;
        await patchAppStage(sessionId, 'discovery', 'reopen', summary || t('blueprint.applyFallbackFeedback'));
        await putAppSpec(sessionId, draft);
        await putBlueprintLayout(sessionId, layout).catch(() => {});
        requestStudioSend(projectId, `${t('blueprint.applyMessage')}${summary ? `\n${summary}` : ''}`);
      } else {
        await putAppSpec(sessionId, draft);
      }
      baselineRef.current = JSON.stringify(draft);
      setDirty(false);
      setConflict(false);
      refresh();
    } catch (e) {
      setIssues([(e as Error).message]);
    } finally {
      setBusy(false);
    }
  }, [draft, busy, discoveryApproved, sessionId, projectId, layout, refresh, t]);

  /** Descarta o draft e re-seeda do servidor. */
  const reload = useCallback(() => {
    setDirty(false);
    setConflict(false);
    setIssues([]);
    baselineRef.current = serverSpecJson;
    setDraft(parseAppSpec(serverSpecJson));
  }, [serverSpecJson]);

  return {
    draft,
    layout,
    dirty,
    conflict,
    busy,
    issues,
    discoveryApproved,
    mutate,
    setNodePosition,
    save,
    reload,
  };
}
