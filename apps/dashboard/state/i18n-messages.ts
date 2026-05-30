/**
 * Message catalogs for the app shell. This is the i18n FOUNDATION, not a full
 * translation of the IDE — only strings that already go through `useT()` live
 * here. Migrate more screens incrementally by replacing hardcoded text with
 * `t('some.key')` and adding the key to both catalogs.
 *
 * Keys are flat, dotted, and namespaced by area. `en` is the fallback for any
 * key missing in another locale.
 */
export type Locale = 'en' | 'pt-BR';

export const LOCALES: Array<{ id: Locale; label: string; nativeLabel: string }> = [
  { id: 'en', label: 'English', nativeLabel: 'English' },
  { id: 'pt-BR', label: 'Portuguese (Brazil)', nativeLabel: 'Português (Brasil)' },
];

export type Messages = Record<string, string>;

export const MESSAGES: Record<Locale, Messages> = {
  en: {
    'nav.projects': 'Projects',
    'nav.agents': 'Agents',
    'nav.settings': 'Settings',
    'nav.design': 'Design',
    'nav.telemetry': 'Telemetry',
    'nav.docs': 'Docs',
    'common.language': 'Language',
    'common.theme': 'Theme',
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'common.run': 'Run',
    'common.close': 'Close',
  },
  'pt-BR': {
    'nav.projects': 'Projetos',
    'nav.agents': 'Agentes',
    'nav.settings': 'Configurações',
    'nav.design': 'Design',
    'nav.telemetry': 'Telemetria',
    'nav.docs': 'Docs',
    'common.language': 'Idioma',
    'common.theme': 'Tema',
    'common.save': 'Salvar',
    'common.cancel': 'Cancelar',
    'common.run': 'Executar',
    'common.close': 'Fechar',
  },
};
