/**
 * gen-settings-i18n — generate the dashboard `settings` i18n namespace from the
 * app-settings catalog (the structural + English source of truth).
 *
 * Emits flat dotted-key JSON (matching the other locale files):
 *   - chrome.*            panel UI strings (English authored here)
 *   - category.<id>       category titles (from SETTING_CATEGORIES)
 *   - item.<KEY>.label    per-setting human label  (from APP_SETTINGS)
 *   - item.<KEY>.description
 *
 * `en/settings.json` is FULLY generated (never hand-edited → no drift with the
 * catalog). `pt-BR/settings.json` keeps existing translations and only gains
 * NEW keys (seeded with the English value as a translate-me placeholder), so
 * re-running after a catalog change never clobbers human translations.
 *
 * Run: pnpm tsx scripts/gen-settings-i18n.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_SETTINGS, SETTING_CATEGORIES } from '../packages/store/src/app-settings-catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const localesRoot = join(repoRoot, 'apps', 'dashboard', 'i18n', 'locales');

/** Panel chrome (English source). pt-BR is translated in pt-BR/settings.json. */
const CHROME_EN: Record<string, string> = {
  'chrome.title': 'Settings',
  'chrome.subtitle':
    'Settings persisted in the database; they override .env for desktop installs. ' +
    'Changes apply immediately when possible; fields marked “restart” require a backend restart.',
  'chrome.searchPlaceholder': 'Search settings…',
  'chrome.showAdvanced': 'Show advanced',
  'chrome.counts': '{{essential}} essential · {{advanced}} advanced',
  'chrome.allCategories': 'All',
  'chrome.empty': 'No settings match your search.',
  'chrome.pending_one': '{{count}} pending change',
  'chrome.pending_other': '{{count}} pending changes',
  'chrome.noPending': 'No pending changes',
  'chrome.restartBackend': 'Restart backend',
  'chrome.save': 'Save',
  'chrome.saveCount': 'Save ({{count}})',
  'chrome.restartBadge': 'restart',
  'chrome.advancedBadge': 'advanced',
  'chrome.discardEdit': 'Discard this edit',
  'chrome.copyKey': 'Copy variable name',
  'chrome.copied': 'Copied',
  'chrome.reveal': 'Show',
  'chrome.hide': 'Hide',
  'chrome.unset': 'unset',
  'chrome.refresh': 'Reload',
  'source.db': 'saved',
  'source.env': '.env',
  'source.default': 'default',
  'source.unset': 'unset',
  'toast.saved': 'Saved {{count}} setting(s)',
  'toast.savedRestart': 'Some changes require a backend restart to take effect.',
  'toast.savedApplied': 'Changes applied immediately.',
  'toast.saveFailed': 'Save failed',
  'toast.restarting': 'Restarting backend…',
  'toast.restartingDesc': 'The host will spawn a fresh backend process in a moment.',
  'toast.restartFailed': 'Restart failed',
  'error.fetch': 'Failed to load settings.',
};

function buildEn(): Record<string, string> {
  const out: Record<string, string> = { ...CHROME_EN };
  for (const cat of SETTING_CATEGORIES) out[`category.${cat.id}`] = cat.label;
  for (const def of APP_SETTINGS) {
    out[`item.${def.key}.label`] = def.label;
    out[`item.${def.key}.description`] = def.description;
  }
  return out;
}

/** Sort keys so the emitted JSON has a stable, diff-friendly order. */
function sortedJson(obj: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted, null, 2) + '\n';
}

function readExisting(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

const en = buildEn();
const enPath = join(localesRoot, 'en', 'settings.json');
writeFileSync(enPath, sortedJson(en));

// pt-BR: preserve existing translations, seed only the missing keys with EN.
const ptPath = join(localesRoot, 'pt-BR', 'settings.json');
const ptExisting = readExisting(ptPath);
const pt: Record<string, string> = {};
let seeded = 0;
for (const key of Object.keys(en)) {
  if (typeof ptExisting[key] === 'string' && ptExisting[key] !== en[key]) {
    pt[key] = ptExisting[key];
  } else {
    pt[key] = en[key];
    seeded++;
  }
}
writeFileSync(ptPath, sortedJson(pt));

console.log(
  `[gen-settings-i18n] ${APP_SETTINGS.length} settings, ${SETTING_CATEGORIES.length} categories. ` +
    `en keys=${Object.keys(en).length}. pt-BR seeded/untranslated=${seeded}.`,
);
