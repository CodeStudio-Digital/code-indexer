import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Download, ExternalLink, Loader2, RotateCcw, Server, WandSparkles } from 'lucide-react';
import type { EditorSettings, EditorSettingsOverride } from '@mcp/shared/editor-settings.js';
import type { EditorStatsResult, LspInstallFrame, LspServerInfo } from '@mcp/api-bus';
import { Switch } from '../../../../components/ui/switch.js';
import { Button } from '../../../../components/ui/button.js';
import { Input } from '../../../../components/ui/input.js';
import { apiCall, apiStream } from '../../../../lib/api-client.js';
import { useEditorSettingsStore, resolveSettingsLayers } from '../../../../state/editor-settings.js';
import { useAiCompleteStore } from '../../../workspace/editor/ai-complete-store.js';
import { AutocompleteSetupDialog } from '../../../workspace/editor/AutocompleteSetupDialog.js';

type Scope = 'global' | 'project';
type Key = Exclude<keyof EditorSettings, 'version'>;
const EMPTY_PROJECT_OVERRIDES = Object.freeze({}) as EditorSettingsOverride;

function SettingRow({ title, description, inherited, overridden, onReset, children }: {
  title: string; description?: string; inherited?: string; overridden: boolean; onReset: () => void; children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(180px,260px)] items-center gap-4 border-b border-border/50 py-3 last:border-0">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          {title}
          {overridden ? <button type="button" onClick={onReset} title="Reset / Herdar" className="text-muted-foreground hover:text-foreground"><RotateCcw className="h-3 w-3" /></button> : null}
        </div>
        {description && <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{description}</p>}
        {!overridden && inherited && <p className="text-[9px] text-violet-400/80">Herdado de {inherited}</p>}
      </div>
      <div className="flex justify-end">{children}</div>
    </div>
  );
}

function ScopeHeader({ scope, setScope }: { scope: Scope; setScope: (scope: Scope) => void }) {
  return (
    <div className="flex items-center justify-between rounded border bg-muted/20 px-3 py-2">
      <div>
        <p className="text-xs font-medium">Escopo das preferências</p>
        <p className="text-[10px] text-muted-foreground">Overrides do projeto ficam no banco roteado; nenhum arquivo é criado no repositório.</p>
      </div>
      <div className="inline-flex rounded border bg-background p-0.5">
        <button type="button" onClick={() => setScope('global')} className={`rounded px-2 py-1 text-[11px] ${scope === 'global' ? 'bg-primary/15 text-primary' : 'text-muted-foreground'}`}>Global</button>
        <button type="button" onClick={() => setScope('project')} className={`rounded px-2 py-1 text-[11px] ${scope === 'project' ? 'bg-primary/15 text-primary' : 'text-muted-foreground'}`}>Este projeto</button>
      </div>
    </div>
  );
}

function usePreferences(projectId: number) {
  const [scope, setScope] = useState<Scope>('global');
  const [error, setError] = useState<string | null>(null);
  const global = useEditorSettingsStore((state) => state.global);
  // useSyncExternalStore requires a referentially stable snapshot. Returning a
  // fresh `{}` while the project settings hydrate causes a React render loop.
  const project = useEditorSettingsStore((state) => state.projects[projectId] ?? EMPTY_PROJECT_OVERRIDES);
  const hydrate = useEditorSettingsStore((state) => state.hydrateProject);
  const setStoreField = useEditorSettingsStore((state) => state.setField);
  const resetStoreField = useEditorSettingsStore((state) => state.resetField);
  useEffect(() => { void hydrate(projectId).catch((reason) => setError(String(reason))); }, [hydrate, projectId]);
  const values = useMemo(
    () => scope === 'global' ? resolveSettingsLayers(global, {}, {}) : resolveSettingsLayers(global, project, {}),
    [global, project, scope],
  );
  const overrides: EditorSettingsOverride = scope === 'global' ? global : project;
  const setField = (key: Key, value: EditorSettings[Key]) => {
    setError(null);
    void setStoreField(scope, projectId, key, value).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  };
  const resetField = (key: Key) => {
    setError(null);
    void resetStoreField(scope, projectId, key).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  };
  return { scope, setScope, values, overrides, setField, resetField, error, inherited: scope === 'global' ? 'padrão do editor' : 'Global / padrão' };
}

function BoolSetting({ pref, name, title, description }: { pref: ReturnType<typeof usePreferences>; name: Key; title: string; description?: string }) {
  return (
    <SettingRow title={title} description={description} inherited={pref.inherited} overridden={name in pref.overrides} onReset={() => pref.resetField(name)}>
      <Switch checked={Boolean(pref.values[name])} onCheckedChange={(checked) => pref.setField(name, checked)} />
    </SettingRow>
  );
}

export function EditorGeneralPane({ projectId }: { projectId: number }) {
  const pref = usePreferences(projectId);
  const rulers = pref.values.rulers.join(', ');
  return (
    <div className="max-w-3xl space-y-4">
      <ScopeHeader scope={pref.scope} setScope={pref.setScope} />
      {pref.error && <div className="rounded border border-destructive/50 p-2 text-xs text-destructive">{pref.error}</div>}
      <section className="rounded border px-3">
        <SettingRow title="Família da fonte" inherited={pref.inherited} overridden={'fontFamily' in pref.overrides} onReset={() => pref.resetField('fontFamily')}>
          <Input className="h-7 text-xs" value={pref.values.fontFamily} onChange={(event) => pref.setField('fontFamily', event.target.value)} />
        </SettingRow>
        <SettingRow title="Tamanho da fonte" description="Vazio segue a densidade da interface." inherited={pref.inherited} overridden={'fontSize' in pref.overrides} onReset={() => pref.resetField('fontSize')}>
          <Input className="h-7 w-24 text-xs" type="number" min={8} max={40} value={pref.values.fontSize ?? ''} placeholder="Auto" onChange={(event) => pref.setField('fontSize', event.target.value ? Number(event.target.value) : null)} />
        </SettingRow>
        <BoolSetting pref={pref} name="fontLigatures" title="Ligaduras" />
        <BoolSetting pref={pref} name="minimap" title="Minimap" />
        <BoolSetting pref={pref} name="stickyScroll" title="Sticky scroll" />
        <SettingRow title="Quebra de linha" inherited={pref.inherited} overridden={'wordWrap' in pref.overrides} onReset={() => pref.resetField('wordWrap')}>
          <select className="h-7 rounded border bg-background px-2 text-xs" value={pref.values.wordWrap} onChange={(event) => pref.setField('wordWrap', event.target.value as EditorSettings['wordWrap'])}>
            <option value="off">Desligada</option><option value="on">Ligada</option><option value="wordWrapColumn">Na coluna</option><option value="bounded">Limitada</option>
          </select>
        </SettingRow>
        <SettingRow title="Exibir espaços" inherited={pref.inherited} overridden={'renderWhitespace' in pref.overrides} onReset={() => pref.resetField('renderWhitespace')}>
          <select className="h-7 rounded border bg-background px-2 text-xs" value={pref.values.renderWhitespace} onChange={(event) => pref.setField('renderWhitespace', event.target.value as EditorSettings['renderWhitespace'])}>
            <option value="none">Nunca</option><option value="selection">Na seleção</option><option value="boundary">Nas bordas</option><option value="trailing">Ao final</option><option value="all">Sempre</option>
          </select>
        </SettingRow>
        <SettingRow title="Réguas" description="Colunas separadas por vírgula." inherited={pref.inherited} overridden={'rulers' in pref.overrides} onReset={() => pref.resetField('rulers')}>
          <Input className="h-7 w-48 text-xs" value={rulers} placeholder="80, 120" onChange={(event) => pref.setField('rulers', event.target.value.split(',').map(Number).filter(Number.isFinite))} />
        </SettingRow>
      </section>
      <p className="text-[10px] text-muted-foreground">A precedência por arquivo é: <code>.editorconfig</code> → Este projeto → Global → padrão. Alterações são aplicadas imediatamente a todos os splits.</p>
    </div>
  );
}

export function EditorCodeStylePane({ projectId }: { projectId: number }) {
  const pref = usePreferences(projectId);
  return (
    <div className="max-w-3xl space-y-4">
      <ScopeHeader scope={pref.scope} setScope={pref.setScope} />
      {pref.error && <div className="rounded border border-destructive/50 p-2 text-xs text-destructive">{pref.error}</div>}
      <section className="rounded border px-3">
        <BoolSetting pref={pref} name="respectEditorConfig" title="Respeitar .editorconfig" description="Configurações encontradas no repositório têm a maior precedência." />
        <BoolSetting pref={pref} name="detectIndentation" title="Detectar indentação do arquivo" />
        <SettingRow title="Tamanho da tabulação" inherited={pref.inherited} overridden={'tabSize' in pref.overrides} onReset={() => pref.resetField('tabSize')}>
          <Input className="h-7 w-20 text-xs" type="number" min={1} max={16} value={pref.values.tabSize} onChange={(event) => pref.setField('tabSize', Number(event.target.value))} />
        </SettingRow>
        <BoolSetting pref={pref} name="insertSpaces" title="Usar espaços em vez de tabs" />
        <SettingRow title="Fim de linha" inherited={pref.inherited} overridden={'endOfLine' in pref.overrides} onReset={() => pref.resetField('endOfLine')}>
          <select className="h-7 rounded border bg-background px-2 text-xs" value={pref.values.endOfLine} onChange={(event) => pref.setField('endOfLine', event.target.value as EditorSettings['endOfLine'])}><option value="auto">Automático</option><option value="lf">LF</option><option value="crlf">CRLF</option></select>
        </SettingRow>
        <BoolSetting pref={pref} name="formatOnPaste" title="Formatar ao colar" />
        <BoolSetting pref={pref} name="formatOnSave" title="Formatar ao salvar" description="Desligado por padrão; formatação permanece manual." />
        <BoolSetting pref={pref} name="formatOnType" title="Formatar ao digitar" description="Desligado por padrão." />
        <BoolSetting pref={pref} name="trimTrailingWhitespace" title="Remover espaços ao final ao salvar" />
        <BoolSetting pref={pref} name="insertFinalNewline" title="Inserir nova linha final ao salvar" />
      </section>
    </div>
  );
}

function LanguageSupport({ projectId }: { projectId: number }) {
  const [servers, setServers] = useState<LspServerInfo[]>([]);
  const [instances, setInstances] = useState<Array<{ projectId: number; serverId: string; state: string }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = async () => {
    const [catalog, live] = await Promise.all([apiCall('lsp.listServers', undefined), apiCall('lsp.instances', undefined)]);
    setServers(catalog); setInstances(live);
  };
  useEffect(() => { void refresh(); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const install = async (serverId: string) => {
    setBusy(serverId);
    try { for await (const frame of apiStream<LspInstallFrame>('lsp.installServerStream', { serverId })) if (frame.phase === 'error') throw new Error(frame.message); }
    finally { setBusy(null); await refresh(); }
  };
  const rows = [
    { language: 'TypeScript / JavaScript', server: null, formatter: 'Worker Monaco' },
    { language: 'PHP', server: servers.find((item) => item.languages.includes('php')), formatter: 'LSP (Intelephense)' },
    { language: 'Python (análise)', server: servers.find((item) => item.id === 'pyright'), formatter: '—' },
    { language: 'Python (formatação)', server: servers.find((item) => item.id === 'ruff'), formatter: 'Ruff' },
    { language: 'JSON / CSS / HTML', server: null, formatter: 'Worker Monaco' },
  ];
  return (
    <section className="rounded border">
      <div className="border-b px-3 py-2"><p className="text-xs font-medium">Linguagens, servidor e formatter</p><p className="text-[10px] text-muted-foreground">Downloads sempre exigem consentimento explícito.</p></div>
      {rows.map((row) => {
        const instance = row.server ? instances.find((item) => item.projectId === projectId && item.serverId === row.server!.id) : null;
        return <div key={row.language} className="grid grid-cols-[1.2fr_1fr_1fr_auto] items-center gap-2 border-b px-3 py-2 text-[11px] last:border-0">
          <span>{row.language}</span><span className="text-muted-foreground">{row.server?.label ?? 'Integrado'}</span><span className="text-muted-foreground">{row.formatter}</span>
          <div className="flex items-center gap-1">
            <span className={row.server && !row.server.installed ? 'text-amber-500' : 'text-emerald-500'}>{instance?.state ?? (row.server?.installed === false ? 'não instalado' : 'pronto')}</span>
            {row.server && !row.server.installed && <Button size="sm" variant="outline" className="h-6 text-[10px]" disabled={busy === row.server.id} onClick={() => void install(row.server!.id)}>{busy === row.server.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}</Button>}
            {row.server?.installed && <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => void apiCall('lsp.restartServer', { projectId, serverId: row.server!.id }).then(refresh)}><RotateCcw className="h-3 w-3" /></Button>}
          </div>
        </div>;
      })}
    </section>
  );
}

export function EditorAutocompletePane({ projectId }: { projectId: number }) {
  const pref = usePreferences(projectId);
  const aiEnabled = useAiCompleteStore((state) => state.enabled);
  const aiBusy = useAiCompleteStore((state) => state.busy);
  const aiIssue = useAiCompleteStore((state) => state.issue);
  const setAiEnabled = useAiCompleteStore((state) => state.setEnabled);
  const [setupOpen, setSetupOpen] = useState(false);
  const [stats, setStats] = useState<EditorStatsResult | null>(null);
  useEffect(() => { void apiCall<EditorStatsResult>('editor.stats', { days: 7 }).then(setStats).catch(() => undefined); }, []);
  return (
    <div className="max-w-4xl space-y-4">
      <ScopeHeader scope={pref.scope} setScope={pref.setScope} />
      <section className="rounded border px-3">
        <BoolSetting pref={pref} name="quickSuggestions" title="Sugestões enquanto digita" />
        <BoolSetting pref={pref} name="suggestOnTriggerCharacters" title="Sugestões por caracteres de gatilho" />
        <SettingRow title="Aceitar com Enter" inherited={pref.inherited} overridden={'acceptSuggestionOnEnter' in pref.overrides} onReset={() => pref.resetField('acceptSuggestionOnEnter')}><select className="h-7 rounded border bg-background px-2 text-xs" value={pref.values.acceptSuggestionOnEnter} onChange={(event) => pref.setField('acceptSuggestionOnEnter', event.target.value as EditorSettings['acceptSuggestionOnEnter'])}><option value="on">Ligado</option><option value="smart">Inteligente</option><option value="off">Desligado</option></select></SettingRow>
        <SettingRow title="Snippets" inherited={pref.inherited} overridden={'snippetSuggestions' in pref.overrides} onReset={() => pref.resetField('snippetSuggestions')}><select className="h-7 rounded border bg-background px-2 text-xs" value={pref.values.snippetSuggestions} onChange={(event) => pref.setField('snippetSuggestions', event.target.value as EditorSettings['snippetSuggestions'])}><option value="top">No topo</option><option value="inline">Misturados</option><option value="bottom">No fim</option><option value="none">Ocultos</option></select></SettingRow>
      </section>

      <LanguageSupport projectId={projectId} />

      <section className="rounded border p-3">
        <div className="flex items-center gap-2"><WandSparkles className="h-4 w-4 text-violet-400" /><div><p className="text-xs font-medium">AI ghost text</p><p className="text-[10px] text-muted-foreground">Reutiliza o pipeline existente; Tab aceita e Alt+\\ aciona manualmente.</p></div><Switch className="ml-auto" checked={aiEnabled} onCheckedChange={setAiEnabled} /></div>
        <div className="mt-3 grid grid-cols-2 gap-2 rounded bg-muted/20 p-2 text-[10px] text-muted-foreground">
          <span>Modelo: <b className="text-foreground">{stats?.model ?? 'não configurado'}</b></span>
          <span>Status: <b className="text-foreground">{aiBusy ? 'gerando…' : aiIssue?.message ?? stats?.route?.health ?? 'ocioso'}</b></span>
          <span>Aceitação (7d): <b className="text-foreground">{stats?.acceptRate == null ? '—' : `${Math.round(stats.acceptRate * 100)}%`}</b></span>
          <span>Modo: <b className="text-foreground">{stats?.route?.suitability === 'best-effort-chat' ? 'manual' : 'automático / manual'}</b></span>
        </div>
        <div className="mt-3 flex gap-2"><Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setSetupOpen(true)}><Server className="mr-1 h-3 w-3" />Configurar / testar</Button><a href="/telemetry?panel=completion" className="inline-flex items-center text-[10px] text-primary hover:underline">Abrir telemetria <ExternalLink className="ml-1 h-3 w-3" /></a></div>
      </section>
      <AutocompleteSetupDialog open={setupOpen} onClose={() => setSetupOpen(false)} />
    </div>
  );
}
