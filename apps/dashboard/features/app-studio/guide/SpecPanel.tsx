/**
 * O PLANO do app em cards legíveis — renderizado no topo do Guia quando a
 * etapa discovery está em revisão: "O que seu app faz / Telas / Dados que
 * ele guarda / Precisa de login? / Fica de fora" + ApproveBar sticky.
 * A aprovação acontece SÓ aqui (o agente não tem tool de aprovar).
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Database, KeyRound, Layout, ScrollText } from 'lucide-react';
import type { AppSpecView } from '../app-studio-api.js';
import { ApproveBar } from './ApproveBar.js';

function Section({ icon: Icon, title, children }: { icon: typeof Layout; title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <Icon className="h-3.5 w-3.5" /> {title}
      </p>
      {children}
    </div>
  );
}

export function SpecPanel({
  spec,
  busy,
  onApprove,
  onReopen,
}: {
  spec: AppSpecView;
  busy: boolean;
  onApprove: () => void;
  onReopen: (feedback: string) => void;
}) {
  const { t } = useTranslation('appStudio');
  const requirementItems = [
    ...(spec.requirements?.goals ?? []),
    ...(spec.requirements?.acceptance_criteria ?? []),
    ...(spec.requirements?.business_rules ?? []),
    ...(spec.requirements?.out_of_scope ?? []).map((item) => `${t('spec.outOfScopePrefix', { defaultValue: 'Fora de escopo' })}: ${item}`),
  ].slice(0, 6);
  return (
    <div className="rounded-lg border border-amber-300/60 bg-amber-50/40 dark:border-amber-400/30 dark:bg-amber-950/20">
      <div className="space-y-3 p-3">
        <Section icon={ScrollText} title={t('spec.what', { defaultValue: 'O que seu app faz' })}>
          <p className="text-sm">{spec.summary}</p>
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {spec.features.map((f) => (
              <li key={f.id}>• {f.name} — {f.description}</li>
            ))}
          </ul>
        </Section>

        {requirementItems.length > 0 && (
          <Section icon={CheckCircle2} title={t('spec.requirements', { defaultValue: 'Requisitos de aprovação' })}>
            <ul className="space-y-0.5 text-xs">
              {requirementItems.map((item) => (
                <li key={item}>• {item}</li>
              ))}
            </ul>
          </Section>
        )}

        <Section icon={Layout} title={t('spec.screens', { defaultValue: 'Telas' })}>
          <ul className="space-y-0.5 text-xs">
            {spec.screens.map((s) => (
              <li key={s.id}>
                <span className="font-medium">{s.label}</span>
                <span className="text-muted-foreground"> — {s.purpose}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section icon={Database} title={t('spec.data', { defaultValue: 'Dados que ele guarda' })}>
          {spec.database.required ? (
            <div className="flex flex-wrap gap-1.5">
              {spec.database.entities.map((e) => (
                <span key={e.name} className="rounded-full border bg-background px-2 py-0.5 text-xs">
                  {e.label} <span className="text-muted-foreground">({e.fields.length})</span>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t('spec.noData', { defaultValue: 'Este app não guarda dados.' })}</p>
          )}
        </Section>

        <Section icon={KeyRound} title={t('spec.login', { defaultValue: 'Precisa de login?' })}>
          <p className="text-xs">
            {spec.auth.enabled
              ? t('spec.loginYes', { defaultValue: 'Sim — algumas partes só entram com senha.' })
              : t('spec.loginNo', { defaultValue: 'Não — o app é aberto.' })}
          </p>
        </Section>
      </div>
      <div className="sticky bottom-0 rounded-b-lg border-t bg-card p-2.5">
        <ApproveBar busy={busy} onApprove={onApprove} onReopen={onReopen} />
      </div>
    </div>
  );
}
