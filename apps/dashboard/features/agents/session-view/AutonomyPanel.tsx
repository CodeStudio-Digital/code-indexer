/**
 * C1 — Autonomy panel: lets the human SEE and STEER the organism.
 *
 * Toggles (scheduler / master supervisor / auto-approve + roles / budget)
 * PATCH `{ autonomy: {...} }` onto the session config — same endpoint the
 * OperationalRulesEditor uses. A prominent Freeze-all button flips
 * `autonomy.freeze`. Initial state comes from GET /autonomy (effective
 * config + persisted incidents + durable [AUTO] posts); live updates ride
 * the SSE stream into the autonomy slice.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Snowflake, Sun } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { apiPatch } from '../../../hooks/useApi.js';
import { apiBaseUrl } from '../../../lib/api-client.js';
import { selectAutonomy, useCompanyStore } from '../../../state/company/index.js';
import type { AutonomyConfigLike, AutonomyEvent } from '../../../state/company/index.js';
import { AutonomyActivityFeed } from './AutonomyActivityFeed.js';

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Persisted incident row (camelCase, migration 107) → feed event. */
function incidentToEvent(row: unknown): AutonomyEvent | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const atMs = num(r.detectedAtMs) ?? Date.now();
  return {
    id: `rest-incident:${str(r.id) ?? atMs}`, atMs, type: 'incident',
    event: 'supervisor_incident', kind: str(r.incidentKind),
    agentRunId: str(r.agentRunId), detail: str(r.detail),
  };
}

/** Durable board post ([AUTO] / [auto-approved]) → feed event. */
function postToEvent(row: unknown): AutonomyEvent | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const content = str(r.content);
  if (!content) return null;
  const createdAt = str(r.created_at);
  const parsed = createdAt ? Date.parse(`${createdAt.replace(' ', 'T')}Z`) : NaN;
  return {
    id: `rest-post:${str(r.id) ?? content.slice(0, 40)}`,
    atMs: Number.isFinite(parsed) ? parsed : Date.now(),
    type: content.startsWith('[auto-approved]') ? 'approval' : 'dispatch',
    detail: content,
  };
}

function rolesToText(v: AutonomyConfigLike['autoApproveRoles']): string {
  if (v === '*') return '*';
  if (Array.isArray(v)) return v.join(', ');
  return '';
}

function parseRoles(text: string): string[] | '*' | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed === '*') return '*';
  const roles = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  return roles.length > 0 ? roles : null;
}

export function AutonomyPanel({ sessionId = null }: { sessionId?: string | null }) {
  const { t } = useTranslation('agents');
  const state = useCompanyStore((s) => selectAutonomy(s, sessionId ?? null));
  const hydrate = useCompanyStore((s) => s.autonomyHydrate);
  const setConfig = useCompanyStore((s) => s.autonomySetConfig);
  const [saving, setSaving] = useState(false);
  const [rolesDraft, setRolesDraft] = useState<string | null>(null);
  const [budgetDraft, setBudgetDraft] = useState<string | null>(null);

  const config = state.config ?? {};
  const frozen = config.freeze === true;
  const autoApproveOn = config.autoApproveRoles === '*'
    || (Array.isArray(config.autoApproveRoles) && config.autoApproveRoles.length > 0);

  const refetch = useCallback(async () => {
    if (sessionId == null) return;
    try {
      const r = await fetch(`${apiBaseUrl()}/api/company/sessions/${sessionId}/autonomy`);
      if (!r.ok) return;
      const body = (await r.json().catch(() => null)) as {
        config?: AutonomyConfigLike | null; incidents?: unknown[]; autoPosts?: unknown[];
      } | null;
      if (!body) return;
      const events = [
        ...(Array.isArray(body.incidents) ? body.incidents : []).map(incidentToEvent),
        ...(Array.isArray(body.autoPosts) ? body.autoPosts : []).map(postToEvent),
      ].filter((e): e is AutonomyEvent => e != null);
      hydrate(sessionId, { config: body.config ?? null, events });
    } catch { /* panel stays on last-known state */ }
  }, [sessionId, hydrate]);

  useEffect(() => { void refetch(); }, [refetch]);

  const patch = useCallback(async (p: Partial<AutonomyConfigLike>) => {
    if (sessionId == null) return;
    setSaving(true);
    setConfig(sessionId, { ...config, ...p }); // optimistic
    try {
      await apiPatch(`/company/sessions/${sessionId}/config`, { autonomy: p });
    } catch {
      await refetch(); // reconcile on rejection (e.g. 400 from sanitize)
    } finally {
      setSaving(false);
    }
  }, [sessionId, config, setConfig, refetch]);

  const disabled = saving || sessionId == null;

  const toggleRow = (key: 'scheduler' | 'supervisorMaster', label: string) => (
    <label className="flex items-center gap-2 text-[11px] cursor-pointer">
      <input
        type="checkbox"
        className="h-3 w-3 accent-primary"
        checked={config[key] === true}
        disabled={disabled}
        onChange={(e) => void patch({ [key]: e.target.checked })}
      />
      <span className="flex-1">{label}</span>
    </label>
  );

  return (
    <div className="space-y-2">
      {frozen && (
        <p className="text-[10px] rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-1 text-sky-600 dark:text-sky-400">
          {t('company.autonomy.frozenBadge')}
        </p>
      )}

      {toggleRow('scheduler', t('company.autonomy.scheduler'))}
      {toggleRow('supervisorMaster', t('company.autonomy.supervisorMaster'))}

      <label className="flex items-center gap-2 text-[11px] cursor-pointer">
        <input
          type="checkbox"
          className="h-3 w-3 accent-primary"
          checked={autoApproveOn}
          disabled={disabled}
          onChange={(e) => {
            if (!e.target.checked) { void patch({ autoApproveRoles: null }); return; }
            void patch({ autoApproveRoles: parseRoles(rolesDraft ?? '') ?? '*' });
          }}
        />
        <span className="flex-1">{t('company.autonomy.autoApprove')}</span>
      </label>
      <input
        type="text"
        value={rolesDraft ?? rolesToText(config.autoApproveRoles)}
        placeholder={t('company.autonomy.autoApproveRolesPlaceholder')}
        disabled={disabled}
        onChange={(e) => setRolesDraft(e.target.value)}
        onBlur={() => {
          if (rolesDraft == null) return;
          void patch({ autoApproveRoles: parseRoles(rolesDraft) });
          setRolesDraft(null);
        }}
        className="w-full rounded border bg-background px-1.5 py-1 text-[10px]"
      />

      <label className="flex items-center gap-2 text-[11px]">
        <span className="flex-1">{t('company.autonomy.maxSubordinates')}</span>
        <input
          type="number"
          min={1}
          value={budgetDraft ?? (config.maxSubordinates ?? '')}
          disabled={disabled}
          onChange={(e) => setBudgetDraft(e.target.value)}
          onBlur={() => {
            if (budgetDraft == null) return;
            const n = parseInt(budgetDraft, 10);
            void patch({ maxSubordinates: Number.isInteger(n) && n > 0 ? n : null });
            setBudgetDraft(null);
          }}
          className="w-16 rounded border bg-background px-1.5 py-0.5 text-[10px]"
        />
      </label>

      <Button
        size="sm"
        variant={frozen ? 'outline' : 'destructive'}
        className="w-full h-7 text-[11px]"
        disabled={disabled}
        onClick={() => void patch({ freeze: !frozen })}
      >
        {frozen
          ? (<><Sun className="h-3 w-3 mr-1" />{t('company.autonomy.unfreeze')}</>)
          : (<><Snowflake className="h-3 w-3 mr-1" />{t('company.autonomy.freezeAll')}</>)}
      </Button>

      <div className="pt-1 border-t">
        <AutonomyActivityFeed sessionId={sessionId} />
      </div>
    </div>
  );
}
