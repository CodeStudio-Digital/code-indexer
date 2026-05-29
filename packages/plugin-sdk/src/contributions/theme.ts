import type { ContributedTheme } from './types.js';

/** Declare a theme (CSS variable overrides on top of the shadcn tokens). */
export function contributeTheme(theme: ContributedTheme): ContributedTheme {
  return theme;
}
