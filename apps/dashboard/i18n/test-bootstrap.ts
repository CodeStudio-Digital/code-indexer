/**
 * Eagerly bundle every locale catalog for tests.
 *
 * Production loads namespaces lazily: only BOOTSTRAP_NAMESPACES ship on the
 * startup path and everything else arrives through `lazyLocaleBackend` when a
 * route mounts. React absorbs the gap via the route-level <Suspense>, but tests
 * that call `renderToStaticMarkup` cannot suspend — react-i18next throws a
 * promise and the render dies with "A component suspended while responding to
 * synchronous input".
 *
 * So any test rendering a component that calls `useTranslation(ns)` for a
 * non-bootstrap namespace must await this first. Loading ALL catalogs (rather
 * than the one namespace under test) is deliberate: it restores the pre-lazy
 * behavior for the test environment and keeps the next component that adds a
 * `useTranslation` from silently breaking an unrelated suite.
 *
 * Awaiting `i18nReady` before registering is required, not cosmetic — importing
 * any dashboard component transitively imports ./index.ts, whose async `init()`
 * would otherwise clobber bundles registered before it settles.
 */
import i18n, { type Resource } from 'i18next';
import { i18nReady } from './index.js';

const localeLoaders = import.meta.glob('./locales/*/*.json', {
  import: 'default',
}) as Record<string, () => Promise<Resource[string][string]>>;

let bundled: Promise<void> | null = null;

export function bootstrapTestI18n(): Promise<void> {
  bundled ??= (async () => {
    await i18nReady;
    await Promise.all(Object.entries(localeLoaders).map(async ([path, load]) => {
      const [, language, namespace] = /^\.\/locales\/([^/]+)\/(.+)\.json$/.exec(path) ?? [];
      if (!language || !namespace) return;
      i18n.addResourceBundle(language, namespace, await load(), true, true);
    }));
  })();
  return bundled;
}
