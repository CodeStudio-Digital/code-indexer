import * as React from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
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
  /**
   * Optional class applied to the dropdown content (Popover). Lets the
   * caller widen the panel beyond the default `min-w-[14rem]` when
   * options carry long descriptions (e.g. the agent picker, where
   * "Commits, snapshots, ops — asks first" would otherwise force the
   * label column to truncate to "S…" / "PL…").
   */
  contentClassName?: string;
  /** Optional callback when a custom (non-listed) value is entered via free text. */
  allowCustom?: boolean;
  /** Lists at or above this size render only the visible rows. */
  virtualizeThreshold?: number;
}

export function containPortalledScroll(event: Pick<React.SyntheticEvent, 'stopPropagation'>): void {
  event.stopPropagation();
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
  contentClassName,
  allowCustom = false,
  virtualizeThreshold = 40,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [highlight, setHighlight] = React.useState(0);
  const [scrollEl, setScrollEl] = React.useState<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listboxId = React.useId();
  const deferredQuery = React.useDeferredValue(query);

  const searchableOptions = React.useMemo(() => options.map((option) => ({
    option,
    searchText: `${option.label} ${option.value} ${option.hint ?? ''} ${option.description ?? ''}`.toLocaleLowerCase(),
  })), [options]);
  const filtered = React.useMemo(() => {
    const q = deferredQuery.trim().toLocaleLowerCase();
    if (!q) return options;
    return searchableOptions
      .filter(({ searchText }) => searchText.includes(q))
      .map(({ option }) => option);
  }, [deferredQuery, options, searchableOptions]);
  const selected = React.useMemo(
    () => options.find((option) => option.value === value),
    [options, value],
  );
  const shouldVirtualize = filtered.length >= virtualizeThreshold;
  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? filtered.length : 0,
    getScrollElement: () => scrollEl,
    estimateSize: () => 34,
    overscan: 8,
  });

  // Reset highlight when filter changes.
  React.useEffect(() => {
    setHighlight(0);
  }, [deferredQuery, open]);

  React.useEffect(() => {
    if (open && shouldVirtualize && filtered.length > 0) {
      virtualizer.scrollToIndex(highlight, { align: 'auto' });
    }
  }, [filtered.length, highlight, open, shouldVirtualize, virtualizer]);

  // Focus the input right after the popover opens.
  React.useEffect(() => {
    if (open) {
      // rAF so Radix has mounted the content.
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery('');
    }
  }, [open]);

  const commit = React.useCallback((val: string) => {
    onChange(val);
    setOpen(false);
  }, [onChange]);

  const handleKey = React.useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, Math.max(0, filtered.length - 1)));
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
  }, [allowCustom, commit, filtered, highlight, query]);

  const handleOptionClick = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    commit(event.currentTarget.dataset.value ?? '');
  }, [commit]);
  const handleOptionMouseMove = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    const index = Number(event.currentTarget.dataset.index);
    setHighlight((current) => (current === index ? current : index));
  }, []);

  const renderOption = (option: ComboboxOption, index: number) => {
    const isSelected = option.value === value;
    const isHighlighted = index === highlight;
    return (
      <button
        key={option.value}
        type="button"
        role="option"
        aria-selected={isSelected}
        data-value={option.value}
        data-index={index}
        onClick={handleOptionClick}
        onMouseMove={handleOptionMouseMove}
        className={cn(
          'flex min-h-8 w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors',
          isHighlighted ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
        )}
      >
        <Check
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            isSelected ? 'opacity-100' : 'opacity-0',
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono">{option.label}</div>
          {option.description && (
            <div className="truncate text-[10px] text-muted-foreground">
              {option.description}
            </div>
          )}
        </div>
        {option.hint && (
          <span className="ml-1 shrink-0 text-[10px] text-muted-foreground">
            {option.hint}
          </span>
        )}
      </button>
    );
  };

  const triggerHeight = size === 'sm' ? 'h-8 text-xs' : 'h-9 text-sm';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
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
        className={cn(
          'p-0 w-[var(--radix-popover-trigger-width)] min-w-[14rem]',
          contentClassName,
        )}
      >
        <div className="flex items-center gap-2 px-2 py-1.5 border-b">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            role="searchbox"
            aria-label={searchPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKey}
            placeholder={searchPlaceholder}
            className="flex-1 bg-transparent outline-none text-xs placeholder:text-muted-foreground"
          />
        </div>
        <div
          id={listboxId}
          ref={setScrollEl}
          role="listbox"
          className="max-h-64 overflow-y-auto overscroll-contain p-1"
          // Radix Dialog locks wheel/touch events outside its content shard.
          // This list is rendered in a Popover portal, so the dialog's
          // document listener otherwise mistakes it for background content
          // and prevents the browser's native scrolling.
          onWheel={containPortalledScroll}
          onTouchMove={containPortalledScroll}
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {emptyLabel}
            </div>
          ) : shouldVirtualize ? (
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const option = filtered[virtualRow.index];
                if (!option) return null;
                return (
                  <div
                    key={option.value}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    className="absolute left-0 top-0 w-full"
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    {renderOption(option, virtualRow.index)}
                  </div>
                );
              })}
            </div>
          ) : (
            filtered.map(renderOption)
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
