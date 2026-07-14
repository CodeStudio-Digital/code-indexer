import type { ReactNode } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { cn } from '../../lib/utils.js';

const EMPTY_VALUE = '__codestudio_api_select_empty__';

export interface ApiClientSelectOption {
  value: string;
  label: ReactNode;
  className?: string;
  disabled?: boolean;
}

interface Props {
  value: string;
  options: ApiClientSelectOption[];
  onValueChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  triggerClassName?: string;
  contentClassName?: string;
}

/**
 * Themed select for the API Client. Native Windows/Electron selects render
 * their popup outside our theme, producing a white menu with unreadable text.
 * Radix keeps the popup inside the CodeStudio token system. The sentinel lets
 * callers keep meaningful empty-string options such as "Top level".
 */
export function ApiClientSelect({
  value,
  options,
  onValueChange,
  placeholder,
  disabled,
  ariaLabel,
  triggerClassName,
  contentClassName,
}: Props) {
  const encode = (candidate: string) => candidate === '' ? EMPTY_VALUE : candidate;
  return (
    <Select
      value={encode(value)}
      onValueChange={(next) => onValueChange(next === EMPTY_VALUE ? '' : next)}
      disabled={disabled}
    >
      <SelectTrigger aria-label={ariaLabel} className={cn('h-8 text-xs', triggerClassName)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper" className={contentClassName}>
        {options.map((option) => (
          <SelectItem
            key={encode(option.value)}
            value={encode(option.value)}
            disabled={option.disabled}
            className={option.className}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
