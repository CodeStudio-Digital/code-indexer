import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RoleEditModal, type RoleConfig, type SkillDef } from '../RoleEditModal.js';

interface ProviderOption {
  id: string;
  label: string;
}

interface NewRoleDialogProps {
  sessionId: number;
  config: Record<string, unknown>;
  initialDraft: RoleConfig;
  skills: SkillDef[];
  providerOptions: ProviderOption[];
  getModelsForProvider: (provider: string) => Array<{ id: string; name: string; mode?: string }>;
  getDefaultModel: (provider: string) => string;
  onClose: () => void;
  onApplied: () => void;
}

/**
 * "Add role" wizard wrapper around `RoleEditModal`. Owns the in-flight
 * draft + validation errors so `CompanySessionView` only has to deal
 * with open/close.
 *
 * Validation mirrors the orchestrator's runtime checks: role names
 * cannot be `master` (reserved), must be unique, and provider/model
 * must come from `allowed_models` when the pool is non-empty. Failing
 * any of those keeps the modal open with an error toast.
 */
export function NewRoleDialog({
  sessionId,
  config,
  initialDraft,
  skills,
  providerOptions,
  getModelsForProvider,
  getDefaultModel,
  onClose,
  onApplied,
}: NewRoleDialogProps) {
  const { t } = useTranslation('agents');
  const [draft, setDraft] = useState<RoleConfig>(initialDraft);
  const [error, setError] = useState<string | null>(null);

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
    if (!roleName) {
      setError(t('company.roleNameRequired'));
      return;
    }
    if (roleName === 'master') {
      setError(t('company.reservedRoleName', { name: roleName }));
      return;
    }
    const existing = (config.role_assignments as Array<Record<string, string>>) ?? [];
    if (existing.some((r) => r.role === roleName)) {
      setError(t('company.duplicateRoleName', { name: roleName }));
      return;
    }
    const pool = (config.allowed_models as Array<{ provider: string; model: string }> | undefined) ?? [];
    if (pool.length > 0) {
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

    const updatedRoles = [...existing, { ...draft, role: roleName }];
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
        roleIdx={-1}
        availableSkills={skills}
        providerOptions={providerOptions}
        getModelsForProvider={getModelsForProvider}
        onCancel={() => {
          setError(null);
          onClose();
        }}
        onUpdate={(p) => patch(p)}
        onClose={() => void commit()}
      />
      {error && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[61] max-w-md rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive shadow-lg">
          {error}
        </div>
      )}
    </div>
  );
}
