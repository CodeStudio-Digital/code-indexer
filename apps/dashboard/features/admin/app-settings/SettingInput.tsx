import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '../../../components/ui/input.js';
import { Switch } from '../../../components/ui/switch.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select.js';
import { cn } from '../../../lib/utils.js';
import type { SettingItem } from './types.js';

/** Type-aware editor: bool→Switch, enum→Select, secret→password+eye, else number/text. */
export function SettingInput({
  item,
  value,
  dirty,
  onChange,
}: {
  item: SettingItem;
  value: string;
  dirty: boolean;
  onChange: (v: string | null) => void;
}) {
  const { t } = useTranslation('settings');
  const [reveal, setReveal] = useState(false);
  const ring = dirty ? 'ring-2 ring-primary/40' : '';

  if (item.type === 'bool') {
    return (
      <Switch
        checked={value === '1' || value === 'true'}
        onCheckedChange={(v) => onChange(v ? '1' : '0')}
        className={cn(ring)}
      />
    );
  }

  if (item.options && item.options.length > 0) {
    return (
      <Select value={value} onValueChange={(v) => onChange(v || null)}>
        <SelectTrigger className={cn('h-8 text-xs', ring)}>
          <SelectValue placeholder={item.default ?? '—'} />
        </SelectTrigger>
        <SelectContent>
          {item.options.map((opt) => (
            <SelectItem key={opt} value={opt}>
              {opt}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (item.type === 'secret') {
    return (
      <div className="flex items-center gap-1 w-full">
        <Input
          type={reveal ? 'text' : 'password'}
          value={dirty ? value : ''}
          placeholder={item.hasValue ? '••••••••' : t('chrome.unset')}
          onChange={(e) => onChange(e.target.value || null)}
          className={cn('h-8 text-xs font-mono', ring)}
        />
        <button
          type="button"
          onClick={() => setReveal((v) => !v)}
          className="text-muted-foreground hover:text-foreground"
          title={reveal ? t('chrome.hide') : t('chrome.reveal')}
        >
          {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </div>
    );
  }

  return (
    <Input
      type={item.type === 'int' || item.type === 'float' ? 'number' : 'text'}
      step={item.type === 'float' ? '0.01' : '1'}
      min={item.min}
      max={item.max}
      value={value}
      placeholder={item.default ?? '—'}
      onChange={(e) => onChange(e.target.value || null)}
      className={cn('h-8 text-xs font-mono', ring)}
    />
  );
}
