import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight,
  Cloud,
  Copy,
  Download,
  FolderOpen,
  Link as LinkIcon,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../components/ui/collapsible.js';
import { Switch } from '../../components/ui/switch.js';
import { cn } from '../../lib/utils.js';
import { SkillEditDialog } from './SkillEditDialog.js';
import { SkillsInstallDialog } from './SkillsInstallDialog.js';
import { SkillsInstallLocalDialog } from './SkillsInstallLocalDialog.js';
import { SkillsInstallUrlDialog } from './SkillsInstallUrlDialog.js';
import { useAdminSkills } from './hooks/useAdminSkills.js';
import {
  listSkillNamespaces,
  updateSkillNamespace,
  uninstallSkillNamespace,
  type AdminSkill,
  type InstalledNamespace,
} from './skills-api.js';

const MODE_LABEL: Record<string, string> = {
  auto: 'Auto',
  tool: 'Tool',
  both: 'Both',
};

const MODE_COLOR: Record<string, string> = {
  auto: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  tool: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  both: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200',
};

const USER_KEY = '__user__';
const BUILTIN_KEY = '__builtin__';
const UNKNOWN_KEY = '__unknown__';

export function SkillsPanel() {
  const { t } = useTranslation(['admin', 'common']);
  const { skills, loading, save, remove, duplicate, doExport, doImport, load: reload } =
    useAdminSkills();
  const [editing, setEditing] = useState<Partial<AdminSkill> | null>(null);
  const [filter, setFilter] = useState('');
  const [installOpen, setInstallOpen] = useState(false);
  const [localInstallOpen, setLocalInstallOpen] = useState(false);
  const [urlInstallOpen, setUrlInstallOpen] = useState(false);
  const [namespaces, setNamespaces] = useState<InstalledNamespace[]>([]);
  const [nsBusy, setNsBusy] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadNamespaces = useCallback(async () => {
    try {
      setNamespaces(await listSkillNamespaces());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadNamespaces();
  }, [loadNamespaces]);

  const handleUpdateNamespace = async (ns: string) => {
    setNsBusy(ns);
    try {
      await updateSkillNamespace(ns);
      await loadNamespaces();
      await reload();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setNsBusy(null);
    }
  };

  const handleUninstallNamespace = async (ns: string) => {
    if (!confirm(`Uninstall all skills from namespace "${ns}"?`)) return;
    setNsBusy(ns);
    try {
      await uninstallSkillNamespace(ns);
      await loadNamespaces();
      await reload();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setNsBusy(null);
    }
  };

  const filtered = filter
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(filter.toLowerCase()) ||
          s.id.includes(filter.toLowerCase()) ||
          (s.tags ?? []).some((t) => t.toLowerCase().includes(filter.toLowerCase())),
      )
    : skills;

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const toggleGroup = useCallback((group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const groups = useMemo(() => {
    const map = new Map<string, AdminSkill[]>();
    for (const s of filtered) {
      let key: string;
      if (s.source === 'user') key = USER_KEY;
      else if (s.source === 'builtin') key = BUILTIN_KEY;
      else if (s.author) key = s.author;
      else key = UNKNOWN_KEY;
      const bucket = map.get(key) ?? [];
      bucket.push(s);
      map.set(key, bucket);
    }
    const sorted = new Map<string, AdminSkill[]>();
    const userBucket = map.get(USER_KEY);
    if (userBucket) sorted.set(USER_KEY, userBucket);
    const namespaceKeys = [...map.keys()]
      .filter((k) => k !== USER_KEY && k !== BUILTIN_KEY && k !== UNKNOWN_KEY)
      .sort((a, b) => a.localeCompare(b));
    for (const ns of namespaceKeys) sorted.set(ns, map.get(ns)!);
    const builtinBucket = map.get(BUILTIN_KEY);
    if (builtinBucket) sorted.set(BUILTIN_KEY, builtinBucket);
    const unknownBucket = map.get(UNKNOWN_KEY);
    if (unknownBucket) sorted.set(UNKNOWN_KEY, unknownBucket);
    return sorted;
  }, [filtered]);

  const namespaceById = useMemo(() => {
    const m = new Map<string, InstalledNamespace>();
    for (const ns of namespaces) m.set(ns.namespace, ns);
    return m;
  }, [namespaces]);

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    await doImport(text);
    // Reset input so same file can be imported again
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('admin:skills.filterPlaceholder')}
          className="flex h-9 w-full max-w-xs rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleImportFile}
            className="hidden"
          />
          <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-4 w-4 mr-2" /> {t('common:actions.import')}
          </Button>
          <Button variant="outline" onClick={() => setInstallOpen(true)}>
            <Cloud className="h-4 w-4 mr-2" /> Install from GitHub
          </Button>
          <Button variant="outline" onClick={() => setUrlInstallOpen(true)}>
            <LinkIcon className="h-4 w-4 mr-2" /> Install from URL
          </Button>
          <Button variant="outline" onClick={() => setLocalInstallOpen(true)}>
            <FolderOpen className="h-4 w-4 mr-2" /> Install from Local Folder
          </Button>
          <Button
            onClick={() =>
              setEditing({
                context_mode: 'auto',
                scope: 'global',
                enabled: true,
                sort_order: 0,
                tags: [],
                version: '1.0.0',
                source: 'user',
              })
            }
          >
            <Plus className="h-4 w-4 mr-2" /> {t('admin:skills.addSkill')}
          </Button>
        </div>
      </div>

      {loading && <div className="text-sm text-muted-foreground">{t('common:actions.loading')}</div>}

      <div className="space-y-4">
        {[...groups.entries()].map(([key, items]) => {
          const isOpen = filter.length > 0 || !collapsedGroups.has(key);
          const isUser = key === USER_KEY;
          const isBuiltin = key === BUILTIN_KEY;
          const isUnknown = key === UNKNOWN_KEY;
          const isNamespace = !isUser && !isBuiltin && !isUnknown;
          const ns = isNamespace ? namespaceById.get(key) : undefined;
          const label = isUser
            ? 'User skills'
            : isBuiltin
              ? 'Built-in'
              : isUnknown
                ? 'Imported (unknown)'
                : key;
          return (
            <Collapsible key={key} open={isOpen} onOpenChange={() => toggleGroup(key)}>
              <div className="flex items-center gap-3 mb-2">
                <CollapsibleTrigger asChild>
                  <button className="flex items-center gap-2 text-sm font-semibold hover:text-primary transition-colors min-w-0">
                    <ChevronRight
                      className={cn('h-4 w-4 shrink-0 transition-transform', isOpen && 'rotate-90')}
                    />
                    <span
                      className={cn(
                        'truncate',
                        (isBuiltin || isUnknown) && 'text-muted-foreground italic',
                      )}
                    >
                      {label}
                    </span>
                  </button>
                </CollapsibleTrigger>
                <Badge variant="secondary">{items.length}</Badge>
                {ns && (ns.repo || ns.commit) && (
                  <span className="text-xs text-muted-foreground font-mono truncate">
                    {ns.repo}
                    {ns.commit && <> @{ns.commit.slice(0, 7)}</>}
                  </span>
                )}
                <div className="flex-1 h-px bg-border" />
                {isNamespace && (
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      disabled={nsBusy === key}
                      onClick={() => void handleUpdateNamespace(key)}
                      title="Update (re-fetch latest)"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      disabled={nsBusy === key}
                      onClick={() => void handleUninstallNamespace(key)}
                      title="Uninstall namespace"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-red-600" />
                    </Button>
                  </div>
                )}
              </div>
              <CollapsibleContent>
                <div className="grid gap-3">
                  {items.map((s) => (
                    <Card key={s.id} className="overflow-hidden">
                      <CardHeader className="py-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3 min-w-0">
                            <Sparkles className="h-4 w-4 text-muted-foreground shrink-0" />
                            <CardTitle className="text-base truncate">{s.name}</CardTitle>
                            <Badge className={MODE_COLOR[s.context_mode] ?? ''}>
                              {MODE_LABEL[s.context_mode] ?? s.context_mode}
                            </Badge>
                            {s.slash_command && (
                              <Badge variant="outline" className="font-mono">
                                /{s.slash_command}
                              </Badge>
                            )}
                            {s.scope !== 'global' && (
                              <Badge variant="secondary">{t('admin:skills.project')}{s.scope}</Badge>
                            )}
                            {(s.tags ?? []).map((tag) => (
                              <Badge key={tag} variant="outline" className="text-xs">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Switch
                              checked={s.enabled}
                              onCheckedChange={(v) => save({ ...s, enabled: v })}
                            />
                            <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => duplicate(s.id)}>
                              <Copy className="h-4 w-4" />
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => doExport(s.id)}>
                              <Download className="h-4 w-4" />
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => remove(s.id)}>
                              <Trash2 className="h-4 w-4 text-red-600" />
                            </Button>
                          </div>
                        </div>
                      </CardHeader>
                      {s.description && (
                        <CardContent className="py-2 text-xs text-muted-foreground">
                          {s.description}
                        </CardContent>
                      )}
                    </Card>
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
        {!loading && filtered.length === 0 && (
          <div className="text-sm text-muted-foreground border rounded-lg p-6 text-center">
            {filter
              ? t('admin:skills.noMatch')
              : t('admin:skills.noSkills')}
          </div>
        )}
      </div>

      <SkillsInstallDialog
        open={installOpen}
        onOpenChange={setInstallOpen}
        onInstalled={() => {
          void loadNamespaces();
          void reload();
        }}
      />

      <SkillsInstallLocalDialog
        open={localInstallOpen}
        onOpenChange={setLocalInstallOpen}
        onInstalled={() => {
          void loadNamespaces();
          void reload();
        }}
      />

      <SkillsInstallUrlDialog
        open={urlInstallOpen}
        onOpenChange={setUrlInstallOpen}
        onInstalled={() => {
          void loadNamespaces();
          void reload();
        }}
      />

      {editing && (
        <SkillEditDialog
          initial={editing}
          isExisting={!!skills.find((x) => x.id === editing.id)}
          onClose={() => setEditing(null)}
          onSave={async (s) => {
            await save(s);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
