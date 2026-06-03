/**
 * BuildDatasetForm — pick a stack profile + teacher provider/model (from the
 * configured providers, same as the rest of the app) + count, then kick off
 * generation and render live progress from the SSE stream. `onCreated`
 * refreshes the parent list.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Input } from '../../components/ui/input.js';
import { Progress } from '../../components/ui/progress.js';
import { Badge } from '../../components/ui/badge.js';
import { Loader2 } from 'lucide-react';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select.js';
import { useProviders } from '../../hooks/useProviders.js';
import type { TrainingProfileDTO } from '@mcp/api-bus';
import { getProfiles } from './api.js';
import { SourcesPanel } from './SourcesPanel.js';
import { useDatasetStream } from './useDatasetStream.js';

const DEFAULT = '__default__';

export function BuildDatasetForm({ projectId, onCreated }: { projectId: number; onCreated: () => void }) {
  const { t } = useTranslation('training');
  const { providerOptions, getModelsForProvider, getDefaultModel } = useProviders();
  const [profiles, setProfiles] = useState<TrainingProfileDTO[]>([]);
  const [profile, setProfile] = useState('react-shadcn-vite');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [count, setCount] = useState(5);
  const [docCollection, setDocCollection] = useState('');
  const { state, start, cancel } = useDatasetStream(onCreated);

  useEffect(() => { void getProfiles().then(setProfiles).catch(() => undefined); }, []);

  const models = provider ? getModelsForProvider(provider) : [];
  const pct = state.total > 0 ? Math.round((state.index / state.total) * 100) : 0;

  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-base">{t('formTitle')}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm">
          <span className="text-muted-foreground">{t('profile')}</span>
          <Select value={profile} onValueChange={setProfile}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {profiles.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        <label className="text-sm">
          <span className="text-muted-foreground">{t('count')}</span>
          <Input type="number" min={1} value={count} onChange={(e) => setCount(Number(e.target.value))} />
        </label>
        <label className="text-sm">
          <span className="text-muted-foreground">{t('provider')}</span>
          <Select
            value={provider || DEFAULT}
            onValueChange={(v) => {
              const p = v === DEFAULT ? '' : v;
              setProvider(p);
              setModel(p ? getDefaultModel(p) : '');
            }}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>{t('providerDefault')}</SelectItem>
              {providerOptions.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        <label className="text-sm">
          <span className="text-muted-foreground">{t('model')}</span>
          <Select value={model || DEFAULT} onValueChange={(v) => setModel(v === DEFAULT ? '' : v)} disabled={!provider}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>{t('modelDefault')}</SelectItem>
              {models.map((m) => <SelectItem key={m.id} value={m.id}>{m.name || m.id}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
      </div>

      <SourcesPanel docCollection={docCollection} onDocCollection={setDocCollection} />

      <div className="flex items-center gap-2">
        {state.running ? (
          <Button variant="destructive" onClick={cancel}>{t('cancel')}</Button>
        ) : (
          <Button
            onClick={() => start({
              projectId, profile, count,
              provider: provider || undefined, model: model || undefined,
              docCollection: docCollection || undefined,
            })}
          >
            {t('generate')}
          </Button>
        )}
        {(state.running || state.index > 0) && (
          <span className="ml-1 inline-flex items-center gap-2 text-sm text-muted-foreground">
            {t('acceptedOf', { accepted: state.accepted, total: state.index })} · ${state.costUsd.toFixed(4)}
            {state.lastVerdict && (
              <Badge variant={state.lastVerdict === 'pass' ? 'default' : 'destructive'}>{state.lastVerdict}</Badge>
            )}
          </span>
        )}
      </div>

      {state.status && (
        <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {state.status}
        </p>
      )}
      {(state.running || state.index > 0) && <Progress value={pct} />}
      {state.note === 'no_seeds' && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
          {t('noSeeds')}
        </p>
      )}
      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
      </CardContent>
    </Card>
  );
}
