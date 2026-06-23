import React from 'react';
import {
  classFor,
  currentValue,
  withGroupValue,
  type ClassGroup,
} from './tailwind-class-model.js';

interface ClassGroupControlsProps {
  groups: ClassGroup[];
  classes: string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
}

/**
 * One labelled <select> per Tailwind control group. `—` clears the group;
 * values the model doesn't own (variants, arbitrary) are untouched by
 * construction (withGroupValue only swaps exact scale members).
 */
export function ClassGroupControls({ groups, classes, disabled, onChange }: ClassGroupControlsProps) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1.5">
      {groups.map((g) => {
        const value = currentValue(classes, g);
        return (
          <label key={g.id} className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className="w-14 truncate text-right" title={g.label}>{g.label}</span>
            <select
              value={value ?? '__unset__'}
              disabled={disabled}
              onChange={(e) => {
                const v = e.target.value;
                onChange(withGroupValue(classes, g, v === '__unset__' ? null : v));
              }}
              className="rounded border bg-background px-1 py-0.5 text-[10px] font-mono disabled:opacity-50 max-w-[96px]"
            >
              <option value="__unset__">—</option>
              {g.values.map((v) => (
                <option key={v || '(bare)'} value={v}>
                  {classFor(g, v)}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </div>
  );
}
