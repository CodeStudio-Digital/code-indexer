/**
 * Editor theme pane — pick the Monaco color scheme (global default for dark and
 * light mode) plus optional per-language overrides (e.g. PHP → IntelliJ
 * Darcula). Like AppearancePane it takes no project/patch props: editor theme
 * is a global UI preference held in state/editor-theme.ts (localStorage).
 *
 * A small read-only Monaco preview reflects the theme that would apply to PHP,
 * so the user sees the palette change live.
 */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Editor from '@monaco-editor/react';
import { setupMonaco } from '../../../../lib/monaco-setup.js';
import { useEditorTheme, resolveThemeId } from '../../../../state/editor-theme.js';
import { THEME_OPTIONS } from '../../../workspace/editor/themes/index.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../components/ui/select.js';

const DARK_THEMES = THEME_OPTIONS.filter((t) => t.appearance === 'dark');
const LIGHT_THEMES = THEME_OPTIONS.filter((t) => t.appearance === 'light');

// Languages offered for per-language overrides — the common ones in this IDE.
// languageId values match the editor's inferLanguage / LSP dispatch keys.
const OVERRIDE_LANGS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'php', label: 'PHP' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'python', label: 'Python' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'json', label: 'JSON' },
  { id: 'sql', label: 'SQL' },
];

const NO_OVERRIDE = '__default__';

const PHP_PREVIEW = `<?php
namespace app\\demo;

use core\\Cache;

class UserService extends Model {
    private int $retries = 3;

    /** Find a user by email, hitting the cache first. */
    public function findUser(string $email): ?User {
        $cached = Cache::get($email);
        return $cached ?? $this->repository->firstWhere('email', $email);
    }
}`;

function isDark(): boolean {
  if (typeof document === 'undefined') return true;
  return document.documentElement.classList.contains('dark');
}

export function EditorThemePane() {
  const { t } = useTranslation(['projects']);
  const darkTheme = useEditorTheme((s) => s.darkTheme);
  const lightTheme = useEditorTheme((s) => s.lightTheme);
  const perLanguage = useEditorTheme((s) => s.perLanguage);
  const setDarkTheme = useEditorTheme((s) => s.setDarkTheme);
  const setLightTheme = useEditorTheme((s) => s.setLightTheme);
  const setLanguageOverride = useEditorTheme((s) => s.setLanguageOverride);

  // The preview <Editor> needs Monaco bundled + our custom themes registered.
  // setupMonaco is idempotent; run it before the child editor's loader inits.
  setupMonaco();
  useEffect(() => { setupMonaco(); }, []);

  const previewTheme = resolveThemeId({
    appearance: isDark() ? 'dark' : 'light',
    languageId: 'php',
    state: { darkTheme, lightTheme, perLanguage },
  });

  return (
    <div className="space-y-5 max-w-2xl">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold">{t('settings.nav.editorTheme')}</h3>
        <p className="text-xs text-muted-foreground">{t('settings.editorTheme.subtitle')}</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t('settings.editorTheme.darkLabel')}</label>
          <Select value={darkTheme} onValueChange={setDarkTheme}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {DARK_THEMES.map((th) => (
                <SelectItem key={th.id} value={th.id}>{th.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t('settings.editorTheme.lightLabel')}</label>
          <Select value={lightTheme} onValueChange={setLightTheme}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {LIGHT_THEMES.map((th) => (
                <SelectItem key={th.id} value={th.id}>{th.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <section className="space-y-2">
        <div className="space-y-0.5">
          <label className="text-sm font-medium">{t('settings.editorTheme.perLanguage')}</label>
          <p className="text-xs text-muted-foreground">{t('settings.editorTheme.perLanguageHint')}</p>
        </div>
        <div className="space-y-1.5">
          {OVERRIDE_LANGS.map((lang) => {
            const current = perLanguage[lang.id] ?? NO_OVERRIDE;
            return (
              <div key={lang.id} className="flex items-center gap-3">
                <span className="w-28 shrink-0 text-sm text-muted-foreground">{lang.label}</span>
                <Select
                  value={current}
                  onValueChange={(v) => setLanguageOverride(lang.id, v === NO_OVERRIDE ? null : v)}
                >
                  <SelectTrigger className="w-full max-w-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_OVERRIDE}>{t('settings.editorTheme.useDefault')}</SelectItem>
                    {THEME_OPTIONS.map((th) => (
                      <SelectItem key={th.id} value={th.id}>{th.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </div>
      </section>

      <section className="space-y-1.5">
        <label className="text-sm font-medium">{t('settings.editorTheme.preview')}</label>
        <div className="rounded-md border overflow-hidden">
          <Editor
            height="220px"
            language="php"
            value={PHP_PREVIEW}
            theme={previewTheme}
            options={{
              readOnly: true,
              domReadOnly: true,
              minimap: { enabled: false },
              fontSize: 12.5,
              lineNumbers: 'on',
              folding: false,
              scrollBeyondLastLine: false,
              renderLineHighlight: 'none',
              overviewRulerLanes: 0,
              scrollbar: { vertical: 'auto', horizontal: 'hidden' },
            }}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t('settings.editorTheme.previewHint')}</p>
      </section>
    </div>
  );
}
