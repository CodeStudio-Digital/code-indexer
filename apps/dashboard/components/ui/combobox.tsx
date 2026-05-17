import * as React from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { Popover, PopoverContent, PopoverTrigger } from './popover.js';

export interface ComboboxOption {
  value: string;
  label: string;
  /** Optional secondary text rendered right-aligned (e.g. model mode). */
  hint?: string|undefined|null;
  /** Optional inline description below label. */
  description?: string;
}

export interface ComboboxProps {
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  /** Size variant matching existing SelectTrigger heights. */
  size?: 'sm' | 'md';
  className?: string;
  /** Optional callback when a custom (non-listed) value is entered via free text. */
  allowCustom?: boolean;
}

/**
 * Searchable single-select combobox. Uses Popover + text filter instead of
 * Radix Select because Select has no built-in search and we don't want to
 * pull in cmdk for a single dropdown.
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyLabel = 'No results',
  disabled,
  size = 'sm',
  className,
  allowCustom = false,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [highlight, setHighlight] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => {
      const hay = `${o.label} ${o.hint ?? ''} ${o.description ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [options, query]);

  // Reset highlight when filter changes.
  React.useEffect(() => {
    setHighlight(0);
  }, [query, open]);

  // Focus the input right after the popover opens.
  React.useEffect(() => {
    if (open) {
      // rAF so Radix has mounted the content.
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery('');
    }
  }, [open]);

  const selected = options.find((o) => o.value === value);

  const commit = (val: string) => {
    onChange(val);
    setOpen(false);
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = filtered[highlight];
      if (opt) commit(opt.value);
      else if (allowCustom && query.trim()) commit(query.trim());
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const triggerHeight = size === 'sm' ? 'h-8 text-xs' : 'h-9 text-sm';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex w-full items-center justify-between rounded-md border border-input bg-background px-3 py-1 shadow-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50',
            triggerHeight,
            className,
          )}
        >
          <span className={cn('truncate text-left', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : placeholder}
          </span>
          <ChevronDown className="h-3.5 w-3.5 opacity-50 shrink-0 ml-1.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="p-0 w-[var(--radix-popover-trigger-width)] min-w-[14rem]"
      >
        <div className="flex items-center gap-2 px-2 py-1.5 border-b">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKey}
            placeholder={searchPlaceholder}
            className="flex-1 bg-transparent outline-none text-xs placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {emptyLabel}
            </div>
          ) : (
            filtered.map((opt, idx) => {
              const isSelected = opt.value === value;
              const isHighlighted = idx === highlight;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => commit(opt.value)}
                  onMouseEnter={() => setHighlight(idx)}
                  className={cn(
                    'w-full flex items-center gap-2 px-2 py-1.5 text-xs text-left rounded-sm transition-colors',
                    isHighlighted ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                  )}
                >
                  <Check
                    className={cn(
                      'h-3.5 w-3.5 shrink-0',
                      isSelected ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-mono">{opt.label}</div>
                    {opt.description && (
                      <div className="truncate text-[10px] text-muted-foreground">
                        {opt.description}
                      </div>
                    )}
                  </div>
                  {opt.hint && (
                    <span className="text-[10px] text-muted-foreground shrink-0 ml-1">
                      {opt.hint}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
