import { describe, it, expect } from 'vitest';
import {
  ALL_GROUPS,
  currentValue,
  withGroupValue,
  type ClassGroup,
} from '../tailwind-class-model.js';

function group(id: string): ClassGroup {
  const g = ALL_GROUPS.find((g) => g.id === id);
  if (!g) throw new Error(`no group ${id}`);
  return g;
}

describe('tailwind-class-model', () => {
  it('disambiguates text size vs text color by scale membership', () => {
    const classes = ['text-xl', 'text-primary', 'font-bold'];
    expect(currentValue(classes, group('text-size'))).toBe('xl');
    expect(currentValue(classes, group('text-color'))).toBe('primary');
  });

  it('reads radius / shadow values by scale membership (Tailwind v4)', () => {
    expect(currentValue(['rounded-xs', 'shadow-md'], group('rounded'))).toBe('xs');
    expect(currentValue(['rounded-xs', 'shadow-md'], group('shadow'))).toBe('md');
    expect(currentValue(['p-4'], group('shadow'))).toBeNull();
  });

  it('replaces in place without touching unrelated classes', () => {
    const next = withGroupValue(['flex', 'p-4', 'md:p-8', 'text-primary'], group('p'), '6');
    expect(next).toEqual(['flex', 'p-6', 'md:p-8', 'text-primary']);
  });

  it('appends when the group was unset and clears on null', () => {
    expect(withGroupValue(['flex'], group('gap'), '4')).toEqual(['flex', 'gap-4']);
    expect(withGroupValue(['flex', 'gap-4'], group('gap'), null)).toEqual(['flex']);
  });

  it('never touches variants or arbitrary values', () => {
    const classes = ['hover:bg-primary', 'w-[37px]', 'bg-card'];
    expect(currentValue(classes, group('bg'))).toBe('card');
    expect(withGroupValue(classes, group('bg'), 'muted')).toEqual([
      'hover:bg-primary', 'w-[37px]', 'bg-muted',
    ]);
  });

  it('display values are bare classes', () => {
    expect(currentValue(['flex', 'gap-2'], group('display'))).toBe('flex');
    expect(withGroupValue(['flex', 'gap-2'], group('display'), 'grid')).toEqual(['grid', 'gap-2']);
  });
});
