/**
 * DocTypeSelect — the "Documentation type" select-box shared by all three
 * Add Source tabs (URL / PDF / Folder). Split out of AddSourceDialog so that
 * already-large file doesn't grow further. Default value 'mixed' never limits
 * the corpus to API references.
 */
import { useTranslation } from 'react-i18next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import type { DocType } from './docs-api.js';

/** Select-box order — `mixed` first since it's the safe, non-limiting default. */
const DOC_TYPE_VALUES: DocType[] = [
  'mixed',
  'api_reference',
  'guide',
  'conceptual',
  'reference',
  'changelog',
  'handbook',
];

interface Props {
  value: DocType;
  onChange: (v: DocType) => void;
}

export function DocTypeSelect({ value, onChange }: Props) {
  const { t } = useTranslation('docs');
  return (
    <div className="space-y-1.5">
      <label htmlFor="docs-doc-type" className="text-sm font-medium leading-none">
        {t('addSource.docType')}
      </label>
      <Select value={value} onValueChange={(v) => onChange(v as DocType)}>
        <SelectTrigger id="docs-doc-type">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DOC_TYPE_VALUES.map((dt) => (
            <SelectItem key={dt} value={dt}>
              {t(`addSource.docTypes.${dt}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[11px] text-muted-foreground">{t('addSource.docTypeHelp')}</p>
    </div>
  );
}
