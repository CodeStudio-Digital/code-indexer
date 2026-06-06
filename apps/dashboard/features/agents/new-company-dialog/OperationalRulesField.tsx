/**
 * Session-level operational-rules field for the new-company dialog.
 *
 * Extracted as a sibling sub-component (like AllowedModelsEditor /
 * BuilderModeSection) to keep NewCompanyDialog off the LOC cap. The rules
 * are persisted under `config_json.operational_rules` and injected verbatim
 * into the master + every subordinate prompt at start/spawn/resume.
 */
import { useTranslation } from 'react-i18next';
import { Textarea } from '../../../components/ui/textarea.js';

interface OperationalRulesFieldProps {
  value: string;
  onChange: (next: string) => void;
}

export function OperationalRulesField({ value, onChange }: OperationalRulesFieldProps) {
  const { t } = useTranslation('agents');
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-foreground">
        {t('company.operationalRules.label')}
        <span className="ml-1 text-[10px] font-normal text-muted-foreground">
          {t('company.operationalRules.hint')}
        </span>
      </label>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('company.operationalRules.placeholder')}
        rows={8}
        className="text-xs resize-y min-h-[140px]"
      />
    </div>
  );
}
