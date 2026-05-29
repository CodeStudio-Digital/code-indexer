/**
 * Shared Zod helpers + regexes for the plugin manifests. Kept in one place
 * so plugin.json / .app.json / marketplace.json validate identically.
 */
import { z } from 'zod';

export const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CONTRIB_ID_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/** Absolute https URL — website/privacy/tos links must not be http or relative. */
export const httpsUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith('https://'), { message: 'must be an https:// URL' });

/**
 * Relative path with no traversal. Plugin-supplied paths are joined onto the
 * install dir, so a leading "/" or drive letter or ".." segment is a
 * path-escape risk — reject them at the schema boundary.
 */
export const relPath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !/^[A-Za-z]:/.test(p) &&
      !p.split(/[/\\]/).includes('..'),
    { message: 'must be a relative path without ".." segments' },
  );
