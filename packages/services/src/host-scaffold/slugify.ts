/**
 * Project-name → folder-slug. Pure + unit-tested. The slug is the only
 * user-derived value that reaches a CLI invocation, so it must be strict:
 * lowercase ASCII, digits, and single dashes only.
 */

// Windows reserved device names — a folder named `con`/`nul`/`com1` is
// unusable on win32, so suffix them to stay cross-platform.
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

const MAX_LEN = 50;

export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // non-alphanumeric → dash
    .replace(/^-+|-+$/g, '') // trim leading/trailing dashes
    .slice(0, MAX_LEN)
    .replace(/-+$/g, ''); // re-trim if slice landed on a dash

  if (!slug) return 'project';
  if (RESERVED.has(slug)) return `${slug}-app`;
  return slug;
}
