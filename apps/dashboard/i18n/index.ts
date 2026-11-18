import i18n, { type BackendModule, type ReadCallback, type Resource } from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

type LocaleResource = Resource[string][string];

// Vite turns every loader into its own async chunk. The previous eager JSON
// imports put every namespace in both languages on the startup path (~800 KB
// decoded), even when the user only opened the project list.
const localeLoaders = import.meta.glob('./locales/*/*.json', {
  import: 'default',
}) as Record<string, () => Promise<LocaleResource>>;

function localeFolder(language: string): 'pt-BR' | 'en' {
  return language.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';
}

const lazyLocaleBackend: BackendModule = {
  type: 'backend',
  init() {},
  read(language: string, namespace: string, callback: ReadCallback) {
    const folder = localeFolder(language);
    const load = localeLoaders[`./locales/${folder}/${namespace}.json`];
    if (!load) {
      callback(new Error(`Unknown locale namespace: ${folder}/${namespace}`), null);
      return;
    }
    void load().then(
      (resource) => callback(null, resource),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), null),
    );
  },
};

// These namespaces are consumed before or during the first project-list paint.
// Product-area catalogs (Admin, Agents, Docs, editors, etc.) are requested by
// react-i18next only when their lazy route mounts.
const BOOTSTRAP_NAMESPACES = ['common', 'pins', 'workspace', 'projects'] as const;

function detectInitialLanguage(): 'pt-BR' | 'en' {
  try {
    const stored = window.localStorage.getItem('i18n-lang');
    if (stored) return localeFolder(stored);
  } catch {
    // Storage can be unavailable in hardened webviews; navigator is enough.
  }
  return localeFolder(typeof navigator === 'undefined' ? 'pt-BR' : navigator.language);
}

async function loadBootstrapResources(language: 'pt-BR' | 'en') {
  // Load the active locale and the Portuguese fallback explicitly. i18next's
  // backend remains responsible for every later route/namespace and for the
  // English catalogs when the language switcher is used.
  const folders = language === 'pt-BR' ? ['pt-BR'] as const : ['en', 'pt-BR'] as const;
  const resources: Resource = {};
  await Promise.all(folders.flatMap((folder) => BOOTSTRAP_NAMESPACES.map(async (namespace) => {
    const load = localeLoaders[`./locales/${folder}/${namespace}.json`];
    if (!load) throw new Error(`Unknown locale namespace: ${folder}/${namespace}`);
    resources[folder] ??= {};
    resources[folder]![namespace] = await load();
  })));
  return resources;
}

i18n
  .use(LanguageDetector)
  .use(lazyLocaleBackend)
  .use(initReactI18next);

export const i18nReady = (async () => {
  const lng = detectInitialLanguage();
  const resources = await loadBootstrapResources(lng);
  await i18n.init({
    lng,
    resources,
    fallbackLng: 'pt-BR',
    supportedLngs: ['pt-BR', 'en'],
    partialBundledLanguages: true,
    ns: [...BOOTSTRAP_NAMESPACES],
    defaultNS: 'common',
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'i18n-lang',
    },
  });
})();

export default i18n;
