/**
 * Pure model behind the visual-edit panel: maps a className list onto a
 * fixed set of Tailwind v3 control groups (the builder scaffold pins
 * tailwindcss@3) and produces the next class list when a group changes.
 *
 * Classes outside the known groups (variants like `md:p-4`, arbitrary
 * values like `w-[37px]`, plugins) are NEVER touched — the panel only
 * owns what it can render, everything else passes through verbatim.
 */

export interface ClassGroup {
  id: string;
  /** Control label (panel renders as-is). */
  label: string;
  /**
   * Class prefix (`p` → `p-4`). `null` = the value IS the class
   * (display: `flex`, `grid`, …).
   */
  prefix: string | null;
  /** Allowed values, in control order. `''` = bare prefix (`rounded`). */
  values: string[];
}

const SPACING = ['0', '0.5', '1', '1.5', '2', '2.5', '3', '3.5', '4', '5', '6', '8', '10', '12', '16', '20', '24'];
const TEXT_COLORS = [
  'foreground', 'muted-foreground', 'primary', 'primary-foreground', 'secondary-foreground',
  'accent-foreground', 'card-foreground', 'destructive', 'white', 'black',
];
const BG_COLORS = [
  'background', 'card', 'muted', 'accent', 'primary', 'secondary', 'destructive', 'transparent', 'white', 'black',
];

/** Layout/sizing groups (left column of the panel). */
export const LAYOUT_GROUPS: ClassGroup[] = [
  { id: 'display', label: 'Display', prefix: null, values: ['block', 'flex', 'grid', 'inline-flex', 'inline-block', 'hidden'] },
  { id: 'flex-dir', label: 'Direction', prefix: 'flex', values: ['row', 'col', 'row-reverse', 'col-reverse'] },
  { id: 'justify', label: 'Justify', prefix: 'justify', values: ['start', 'center', 'end', 'between', 'around'] },
  { id: 'items', label: 'Align', prefix: 'items', values: ['start', 'center', 'end', 'stretch', 'baseline'] },
  { id: 'gap', label: 'Gap', prefix: 'gap', values: SPACING },
  { id: 'p', label: 'Padding', prefix: 'p', values: SPACING },
  { id: 'px', label: 'Pad X', prefix: 'px', values: SPACING },
  { id: 'py', label: 'Pad Y', prefix: 'py', values: SPACING },
  { id: 'm', label: 'Margin', prefix: 'm', values: SPACING },
  { id: 'w', label: 'Width', prefix: 'w', values: ['auto', 'full', 'fit', '1/2', '1/3', '2/3', '1/4', '3/4'] },
  { id: 'h', label: 'Height', prefix: 'h', values: ['auto', 'full', 'fit', 'screen'] },
];

/** Typography/color/effects groups (right column of the panel). */
export const STYLE_GROUPS: ClassGroup[] = [
  { id: 'text-size', label: 'Text size', prefix: 'text', values: ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl'] },
  { id: 'font-weight', label: 'Weight', prefix: 'font', values: ['light', 'normal', 'medium', 'semibold', 'bold'] },
  { id: 'text-color', label: 'Text color', prefix: 'text', values: TEXT_COLORS },
  { id: 'bg', label: 'Background', prefix: 'bg', values: BG_COLORS },
  { id: 'rounded', label: 'Radius', prefix: 'rounded', values: ['none', 'sm', '', 'md', 'lg', 'xl', '2xl', 'full'] },
  { id: 'shadow', label: 'Shadow', prefix: 'shadow', values: ['none', 'sm', '', 'md', 'lg', 'xl'] },
];

export const ALL_GROUPS: ClassGroup[] = [...LAYOUT_GROUPS, ...STYLE_GROUPS];

/** True when `cls` belongs to `group` (exact scale membership only). */
function belongs(cls: string, group: ClassGroup): boolean {
  if (group.prefix === null) return group.values.includes(cls);
  if (cls === group.prefix) return group.values.includes('');
  if (!cls.startsWith(`${group.prefix}-`)) return false;
  return group.values.includes(cls.slice(group.prefix.length + 1));
}

/** Build the class for a group value (`''` → bare prefix). */
export function classFor(group: ClassGroup, value: string): string {
  if (group.prefix === null) return value;
  return value === '' ? group.prefix : `${group.prefix}-${value}`;
}

/** Current value of `group` in `classes`, or null when unset. */
export function currentValue(classes: readonly string[], group: ClassGroup): string | null {
  for (const cls of classes) {
    if (!belongs(cls, group)) continue;
    if (group.prefix === null) return cls;
    return cls === group.prefix ? '' : cls.slice(group.prefix.length + 1);
  }
  return null;
}

/**
 * Next class list with `group` set to `value` (null clears the group).
 * Position is preserved when replacing in place; new values append.
 */
export function withGroupValue(
  classes: readonly string[],
  group: ClassGroup,
  value: string | null,
): string[] {
  const replaced: string[] = [];
  let injected = false;
  for (const cls of classes) {
    if (belongs(cls, group)) {
      if (value !== null && !injected) {
        replaced.push(classFor(group, value));
        injected = true;
      }
      continue; // drop other members of the group (and the cleared one)
    }
    replaced.push(cls);
  }
  if (value !== null && !injected) replaced.push(classFor(group, value));
  return replaced;
}
