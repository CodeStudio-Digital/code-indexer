const MAX_SLUG_LENGTH = 48;
const FALLBACK_SLUG = 'asset';
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Turn a display name into a filesystem/URL-safe kebab-case slug:
 * ASCII-folds accents (é -> e), lowercases, strips everything outside
 * [a-z0-9-], collapses dashes, caps at 48 chars. Falls back to "asset"
 * when nothing usable remains.
 */
export function slugify(name: string): string {
  const folded = name.normalize('NFKD').replace(COMBINING_MARKS, '');
  let slug = folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > MAX_SLUG_LENGTH) {
    slug = slug.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '');
  }
  return slug.length > 0 ? slug : FALLBACK_SLUG;
}

/**
 * Return `base` if free, otherwise append `-2`, `-3`, ... until `exists`
 * reports a free slug. The suffixed result still respects the 48-char cap
 * (the base is trimmed to make room for the suffix).
 */
export function uniqueSlug(base: string, exists: (slug: string) => boolean): string {
  if (!exists(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const trimmed = base
      .slice(0, MAX_SLUG_LENGTH - suffix.length)
      .replace(/-+$/g, '');
    const candidate = `${trimmed}${suffix}`;
    if (!exists(candidate)) return candidate;
  }
}
