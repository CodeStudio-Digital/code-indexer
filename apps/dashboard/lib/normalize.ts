/**
 * Accent-insensitive, case-folded normalizer for substring search. Strips
 * diacritics (NFD + combining-mark removal) so "configuracao" matches
 * "Configuração". Shared by the settings rail filter and the app-settings
 * filter so both behave identically.
 */
export const norm = (s: string): string =>
  s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
