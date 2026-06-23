/**
 * Seletor de "language level" do arquivo ativo (estilo PHPStorm). Mostra
 * "PHP: 8.2" / "Python: 3.11" e abre um dropdown de versões; a escolha persiste no
 * projeto (`lsp.setLanguageLevel`) e reinicia o server para reler a config, fazendo
 * o autocomplete + hover de símbolos NATIVOS respeitar a versão.
 *
 * A versão exibida é a EFETIVA (`lsp.languageLevels`): escolha explícita, senão
 * auto-detect do manifesto (composer.json/pyproject.toml — marcada "auto"), senão o
 * default. Auto-oculta para linguagens sem versão configurável (só php/python).
 */
import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { languageIdForPath } from '@mcp/shared/utils/language-id.js';
import { isLangLevelKey, levelsFor, defaultLevelFor, type LangLevelKey } from '@mcp/shared/utils/language-levels.js';
import { apiCall } from '../../../../lib/api-client.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../../../components/ui/popover.js';
import { cn } from '../../../../lib/utils.js';

const LABEL: Record<LangLevelKey, string> = { php: 'PHP', python: 'Python' };
type Source = 'explicit' | 'detected' | 'default';
type Levels = Record<LangLevelKey, { level: string; source: Source }>;

export function LanguageLevelChip({ projectId, activeFilePath }: { projectId: number; activeFilePath: string | null }) {
  const lang = activeFilePath ? languageIdForPath(activeFilePath) : null;
  const isLevelLang = !!lang && isLangLevelKey(lang);
  const [levels, setLevels] = useState<Levels | null>(null);
  const [open, setOpen] = useState(false);
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  // Versões efetivas (explícita/detectada/default) — refaz na troca de projeto + após escolher.
  useEffect(() => {
    if (!isLevelLang) {
      setLevels(null);
      return;
    }
    let cancelled = false;
    apiCall<Levels>('lsp.languageLevels', { projectId })
      .then((r) => { if (!cancelled) setLevels(r); })
      .catch(() => { /* mantém o fallback de default */ });
    return () => { cancelled = true; };
  }, [projectId, isLevelLang, tick]);

  // Troca de projeto zera a escolha otimista (não exibir a versão do projeto anterior).
  useEffect(() => setOptimistic(null), [projectId]);

  if (!isLevelLang) return null;
  const key = lang as LangLevelKey;
  const entry = levels?.[key];
  const current = optimistic ?? entry?.level ?? defaultLevelFor(key);
  const source: Source = optimistic ? 'explicit' : entry?.source ?? 'default';

  const choose = async (level: string) => {
    setOptimistic(level);
    setOpen(false);
    setBusy(true);
    try {
      await apiCall('lsp.setLanguageLevel', { projectId, languageId: key, level });
      setTick((t) => t + 1); // relê: a fonte passa a 'explicit'
    } catch {
      setOptimistic(null); // reverte a exibição se falhar
    } finally {
      setBusy(false);
    }
  };

  const title =
    source === 'detected'
      ? `${LABEL[key]} ${current} — detectado do manifesto (clique p/ fixar)`
      : source === 'default'
        ? `${LABEL[key]} language level (padrão — clique p/ fixar)`
        : `${LABEL[key]} language level`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={title}
          className={cn(
            'inline-flex items-center gap-1 cursor-pointer text-muted-foreground hover:text-foreground transition-colors',
            busy && 'opacity-60',
          )}
        >
          {LABEL[key]}: {current}
          {/* CLS-safe: reserve the badge width always (invisible when not
              auto-detected) so it doesn't appear after async detection and
              shove the right-aligned chips. */}
          <span className={cn('opacity-60 text-[10px]', source !== 'detected' && 'invisible')}>auto</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-44 p-1">
        <div className="px-2 py-1 text-[11px] text-muted-foreground">{LABEL[key]} language level</div>
        <div className="max-h-64 overflow-auto">
          {[...levelsFor(key)].reverse().map((lvl) => (
            <button
              key={lvl}
              type="button"
              onClick={() => void choose(lvl)}
              className={cn(
                'flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-muted',
                lvl === current && 'font-medium text-foreground',
              )}
            >
              <span>{lvl}</span>
              {lvl === current && <Check className="h-3 w-3" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
