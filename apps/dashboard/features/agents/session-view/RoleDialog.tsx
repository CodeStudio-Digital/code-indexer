import type { UseProvidersResult } from '../../../hooks/useProviders.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RoleEditModal, type RoleConfig, type SkillDef } from '../RoleEditModal.js';
import type { useCompanyStream } from '../../../hooks/useCompanyStream.js';


interface RoleDialogProps {
  sessionId: string;
  config: Record<string, unknown>;
  initialDraft: RoleConfig;
  /** When set, the dialog EDITS `role_assignments[editIdx]` instead of appending. */
  editIdx?: number;
  /** Live runtime — provider/model edits on a running session hot-swap via switchProvider. */
  stream: ReturnType<typeof useCompanyStream>;
  skills: SkillDef[];
  providerOptions: UseProvidersResult['providerOptions'];
  getModelsForProvider: UseProvidersResult['getModelsForProvider'];
  getDefaultModel: (provider: string) => string;
  onClose: () => void;
  onApplied: () => void;
}

/**
 * Create/edit wrapper around `RoleEditModal`. Owns the in-flight draft +
 * validation errors so `CompanySessionView` only deals with open/close.
 *
 * Create mode appends to `role_assignments`; edit mode replaces the row at
 * `editIdx` — making tier, systemPromptOverride, skills, temperature,
 * thinking and fallback editable for EXISTING roles (the modal always had
 * the fields; they were only reachable at creation time).
 *
 * Validation mirrors the orchestrator's runtime checks: `master` is a
 * reserved name (and cannot be renamed away in edit mode), names must be
 * unique, and provider/model must come from `allowed_models` when the pool
 * is non-empty. Provider/model changes in edit mode hot-swap the running
 * session via `stream.switchProvider` (same path the old inline editor
 * used) before persisting.
 */
export function RoleDialog({
  sessionId,
  config,
  initialDraft,
  editIdx,
  stream,
  skills,
  providerOptions,
  getModelsForProvider,
  getDefaultModel,
  onClose,
  onApplied,
}: RoleDialogProps) {
  const { t } = useTranslation('agents');
  const [draft, setDraft] = useState<RoleConfig>(initialDraft);
  const [error, setError] = useState<string | null>(null);
  const isEdit = editIdx != null;

  function patch(p: Partial<RoleConfig>) {
    setDraft((prev) => {
      const updated = { ...prev, ...p };
      if (p.provider && p.provider !== prev.provider) {
        updated.model = getDefaultModel(p.provider);
      }
      return updated;
    });
  }

  async function commit() {
    const roleName = draft.role.trim();
    const existing = (config.role_assignments as Array<Record<string, unknown>>) ?? [];
    const original = isEdit ? (existing[editIdx] as Record<string, unknown> | undefined) : undefined;
    const isMasterEdit = original?.role === 'master';

    if (!roleName) {
      setError(t('company.roleNameRequired'));
      return;
    }
    // `master` is structural: cannot be created, cannot be renamed away.
    if (isMasterEdit ? roleName !== 'master' : roleName === 'master') {
      setError(t('company.reservedRoleName', { name: roleName }));
      return;
    }
    if (existing.some((r, i) => r.role === roleName && (!isEdit || i !== editIdx))) {
      setError(t('company.duplicateRoleName', { name: roleName }));
      return;
    }
    const pool = (config.allowed_models as Array<{ provider: string; model: string }> | undefined) ?? [];
    if (pool.length > 0 && !isMasterEdit) {
      const inPool = pool.some((e) => e.provider === draft.provider && e.model === draft.model);
      if (!inPool) {
        setError(
          t('company.modelNotInPool', {
            provider: draft.provider,
            model: draft.model,
            options: pool.map((e) => `${e.provider}/${e.model}`).join(', '),
          }),
        );
        return;
      }
    }

    const cleaned = { ...draft, role: roleName };
    const updatedRoles = isEdit
      ? existing.map((r, i) => (i === editIdx ? cleaned : r))
      : [...existing, cleaned];

    // Hot-swap a RUNNING session when provider/model changed in edit mode —
    // mirrors the retired inline editor's applyRoleProviderChange path. The
    // PATCH below is still the source of truth; a failed swap reconciles on
    // the next spawn/refetch.
    if (isEdit && original && (original.provider !== cleaned.provider || original.model !== cleaned.model)) {
      const masterRow = existing.find((x) => x.role === 'master');
      try {
        await stream.switchProvider(
          isMasterEdit
            ? cleaned.provider
            : ((config.master_provider as string | undefined) ?? (masterRow?.provider as string | undefined) ?? cleaned.provider),
          isMasterEdit
            ? cleaned.model
            : ((config.master_model as string | undefined) ?? (masterRow?.model as string | undefined)),
          updatedRoles as Array<{ role: string; provider: string; model: string; tier: string }>,
        );
      } catch {
        /* live swap is best-effort */
      }
    }

    try {
      const res = await fetch(`/api/company/sessions/${sessionId}/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role_assignments: updatedRoles }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    onApplied();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-[55] flex flex-col items-center justify-end sm:justify-center">
      <RoleEditModal
        role={draft}
        roleIdx={editIdx ?? -1}
        availableSkills={skills}
        providerOptions={providerOptions}
        getModelsForProvider={getModelsForProvider}
        onCancel={() => {
          setError(null);
          onClose();
        }}
        onUpdate={(p) => patch(p)}
        onClose={() => void commit()}
        inheritedToolTiers={[
          'company',
          ...(draft.role === 'qa' || draft.skills?.includes('qa-playwright') ? ['qa'] : []),
          ...(['qa', 'frontend', 'ux', 'fullstack'].includes(draft.role) ? ['preview'] : []),
          ...(draft.role === 'database' ? ['db'] : []),
        ]}
      />
      {error && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[61] max-w-md rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive shadow-lg">
          {error}
        </div>
      )}
    </div>
  );
}
