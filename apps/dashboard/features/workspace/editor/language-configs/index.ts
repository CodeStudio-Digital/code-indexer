/**
 * Applies the language-configuration overlays. Called once from
 * setupMonaco() — global and idempotent by construction (registering the
 * same partial conf twice is harmless; last registration wins per
 * property). NOT in registerLspProviders: configs are per LANGUAGE, not
 * per project.
 */
import type * as MonacoNs from 'monaco-editor';
import { LANGUAGE_CONFIG_OVERLAYS } from './data.js';

export function applyLanguageConfigOverlays(monaco: typeof MonacoNs): void {
  for (const [languageId, conf] of Object.entries(LANGUAGE_CONFIG_OVERLAYS)) {
    monaco.languages.setLanguageConfiguration(languageId, conf);
  }
}
