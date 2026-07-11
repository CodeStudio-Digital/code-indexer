import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Bot, Check, CircleDot, ListChecks, Loader2, Palette, RotateCcw, Workflow } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { prompt } from '../../../components/ui/prompt-dialog.js';
import { cn } from '../../../lib/utils.js';
import { patchAppStage, patchBuildGroup, type AppStudioSessionDetail } from '../app-studio-api.js';
import { ApproveBar } from '../guide/ApproveBar.js';

type ExperienceView = 'direction' | 'flows' | 'wireframes' | 'plan';

export function ExperiencePanel({
  detail,
  onChanged,
  onOpenUxAgent,
  onOpenWireframeAgent,
}: {
  detail: AppStudioSessionDetail;
  onChanged: () => void;
  onOpenUxAgent?: (prompt: string) => void;
  onOpenWireframeAgent?: (prompt: string) => void;
}) {
  const { t } = useTranslation('appStudio');
  const [view, setView] = useState<ExperienceView>('direction');
  const [selectedFlow, setSelectedFlow] = useState(detail.wireframe?.plan.flows[0]?.id ?? null);
  const [selectedScreen, setSelectedScreen] = useState(detail.wireframe?.plan.screens[0]?.screen_id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uxStage = detail.pipeline?.stages.find((stage) => stage.id === 'ux');
  const wireframeStage = detail.pipeline?.stages.find((stage) => stage.id === 'wireframe');

  async function stageAction(stage: 'ux' | 'wireframe', action: 'approve' | 'reopen', feedback?: string) {
    setBusy(true); setError(null);
    try { await patchAppStage(detail.session.id, stage, action, feedback); onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function groupAction(groupId: string, action: 'approve' | 'reopen') {
    let feedback: string | undefined;
    if (action === 'reopen') {
      feedback = await prompt({ title: t('experience.changeGroup'), description: t('experience.changeGroupHint'), placeholder: t('pipeline.feedbackPlaceholder'), confirmLabel: t('pipeline.reopenConfirm') }) ?? undefined;
      if (!feedback) return;
    }
    setBusy(true); setError(null);
    try { await patchBuildGroup(detail.session.id, groupId, action, feedback); onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const flow = detail.wireframe?.plan.flows.find((item) => item.id === selectedFlow) ?? detail.wireframe?.plan.flows[0];
  const flowGraph = useMemo(() => {
    const nodes: Node[] = (flow?.steps ?? []).map((step, index) => ({
      id: step.id,
      position: { x: index * 250, y: (index % 2) * 130 },
      data: { label: `${step.action}\n${step.result}` },
      style: { width: 210, borderRadius: 6, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))', color: 'hsl(var(--foreground))', fontSize: 12, whiteSpace: 'pre-wrap' },
    }));
    const edges: Edge[] = (flow?.steps ?? []).flatMap((step) => step.next_step_ids.map((next) => ({ id: `${step.id}-${next}`, source: step.id, target: next, type: 'smoothstep' })));
    return { nodes, edges };
  }, [flow]);
  const wireframe = detail.wireframe?.plan.screens.find((item) => item.screen_id === selectedScreen) ?? detail.wireframe?.plan.screens[0];

  const views: Array<{ id: ExperienceView; label: string; icon: typeof Palette }> = [
    { id: 'direction', label: t('experience.direction'), icon: Palette },
    { id: 'flows', label: t('experience.flows'), icon: Workflow },
    { id: 'wireframes', label: t('experience.wireframes'), icon: CircleDot },
    { id: 'plan', label: t('experience.plan'), icon: ListChecks },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b px-3">
        {views.map(({ id, label, icon: Icon }) => (
          <Button key={id} variant={view === id ? 'secondary' : 'ghost'} size="sm" className="h-7 shrink-0 text-xs" onClick={() => setView(id)}>
            <Icon className="mr-1 h-3.5 w-3.5" />{label}
          </Button>
        ))}
        <div className="min-w-2 flex-1" />
        {view === 'direction' && <Button size="sm" variant="outline" className="h-7 shrink-0 text-xs" onClick={() => onOpenUxAgent?.(t('stageMessage.ux'))}><Bot className="mr-1 h-3.5 w-3.5" />{t('experience.openUxAgent')}</Button>}
        {(view === 'flows' || view === 'wireframes' || view === 'plan') && <Button size="sm" variant="outline" className="h-7 shrink-0 text-xs" onClick={() => onOpenWireframeAgent?.(t('stageMessage.wireframe'))}><Bot className="mr-1 h-3.5 w-3.5" />{t('experience.openWireframeAgent')}</Button>}
      </header>
      {error && <div className="border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>}
      <div className="min-h-0 flex-1 overflow-hidden">
        {view === 'direction' && (
          <div className="h-full overflow-auto p-4">
            {!detail.ux ? <Empty text={t('experience.noUx')} /> : <>
              <div className="mb-4"><h2 className="text-base font-semibold">{t('experience.direction')}</h2><p className="text-sm text-muted-foreground">{detail.ux.brief.summary}</p></div>
              <div className="grid gap-3 lg:grid-cols-3">
                {detail.ux.brief.directions.map((direction) => {
                  const selected = direction.id === detail.ux!.brief.selected_direction_id;
                  return <article key={direction.id} className={cn('rounded-md border p-3', selected && 'border-primary bg-primary/5')}>
                    <div className="flex items-center gap-2"><h3 className="flex-1 text-sm font-semibold">{direction.name}</h3>{selected && <Check className="h-4 w-4 text-primary" />}</div>
                    <p className="mt-1 min-h-12 text-xs text-muted-foreground">{direction.rationale}</p>
                    <div className="my-3 flex h-8 overflow-hidden rounded border">{direction.palette.map((color) => <span key={color} className="flex-1" style={{ backgroundColor: color }} title={color} />)}</div>
                    <div className="text-xs"><strong>{direction.typography}</strong><span className="ml-2 text-muted-foreground">{direction.density}</span></div>
                  </article>;
                })}
              </div>
              <section className="mt-4 grid gap-4 border-t pt-4 md:grid-cols-3">
                <div><h3 className="text-xs font-semibold uppercase text-muted-foreground">{t('experience.navigation')}</h3><p className="mt-1 text-sm">{detail.ux.brief.navigation}</p></div>
                <div><h3 className="text-xs font-semibold uppercase text-muted-foreground">{t('experience.principles')}</h3><ul className="mt-1 space-y-1 text-sm">{detail.ux.brief.principles.map((item) => <li key={item}>• {item}</li>)}</ul></div>
                <div><h3 className="text-xs font-semibold uppercase text-muted-foreground">{t('experience.accessibility')}</h3><p className="mt-1 text-sm">{detail.ux.brief.accessibility.standard} · {detail.ux.brief.accessibility.contrast}</p></div>
              </section>
              {uxStage?.status === 'review' && <div className="mt-4 border-t pt-4"><ApproveBar busy={busy} onApprove={() => void stageAction('ux', 'approve')} onReopen={(feedback) => void stageAction('ux', 'reopen', feedback)} /></div>}
            </>}
          </div>
        )}
        {view === 'flows' && (
          <div className="flex h-full min-h-0">
            <aside className="w-40 shrink-0 overflow-auto border-r p-2 md:w-60">{detail.wireframe?.plan.flows.map((item) => <button key={item.id} className={cn('mb-1 w-full rounded px-2 py-2 text-left text-xs', item.id === flow?.id ? 'bg-accent text-accent-foreground' : 'hover:bg-muted')} onClick={() => setSelectedFlow(item.id)}><strong className="block">{item.name}</strong><span className="text-muted-foreground">{item.goal}</span></button>)}</aside>
            <div className="min-w-0 flex-1"><ReactFlow nodes={flowGraph.nodes} edges={flowGraph.edges} fitView minZoom={0.35} proOptions={{ hideAttribution: true }}><Background gap={18} /><Controls /></ReactFlow></div>
          </div>
        )}
        {view === 'wireframes' && (
          <div className="flex h-full min-h-0">
            <aside className="w-36 shrink-0 overflow-auto border-r p-2 md:w-52">{detail.wireframe?.plan.screens.map((item) => <button key={item.screen_id} className={cn('mb-1 w-full rounded px-2 py-2 text-left text-xs', item.screen_id === wireframe?.screen_id ? 'bg-accent' : 'hover:bg-muted')} onClick={() => setSelectedScreen(item.screen_id)}><strong>{detail.spec?.screens.find((screen) => screen.id === item.screen_id)?.label ?? item.screen_id}</strong><span className="block text-muted-foreground">{item.route}</span></button>)}</aside>
            <main className="min-w-0 flex-1 overflow-auto bg-muted/20 p-5">{wireframe ? <div className="mx-auto max-w-4xl border bg-background shadow-sm"><header className="border-b px-4 py-3"><h2 className="text-sm font-semibold">{wireframe.hierarchy[0] ?? wireframe.screen_id}</h2><p className="text-xs text-muted-foreground">{wireframe.route}</p></header><div className="grid gap-3 p-4 md:grid-cols-2">{wireframe.regions.map((region) => <section key={region.id} className="min-h-28 rounded border border-dashed p-3"><h3 className="text-xs font-semibold">{region.purpose}</h3><div className="mt-2 space-y-1">{region.components.map((component) => <div key={component} className="h-7 rounded bg-muted px-2 py-1 text-xs text-muted-foreground">{component}</div>)}</div></section>)}</div></div> : <Empty text={t('experience.noWireframe')} />}</main>
            <aside className="hidden w-72 shrink-0 overflow-auto border-l p-3 text-xs lg:block">{wireframe && <><h3 className="font-semibold">{t('experience.dataBindings')}</h3>{wireframe.data_bindings.map((binding) => <div key={`${binding.entity}-${binding.purpose}`} className="mt-2 border-b pb-2"><strong>{binding.entity}</strong><p className="text-muted-foreground">{binding.fields.join(', ')}</p><p>{binding.fixture_scenario}</p></div>)}<h3 className="mt-4 font-semibold">{t('experience.states')}</h3><div className="mt-1 flex flex-wrap gap-1">{wireframe.states.map((state) => <span key={state} className="rounded bg-muted px-1.5 py-0.5">{state}</span>)}</div><h3 className="mt-4 font-semibold">Responsive</h3><p className="mt-1 text-muted-foreground">{wireframe.responsive}</p></>}</aside>
          </div>
        )}
        {view === 'plan' && (
          <div className="h-full overflow-auto p-4">{!detail.wireframe ? <Empty text={t('experience.noPlan')} /> : <div className="space-y-3">{[...detail.wireframe.plan.build_groups].sort((a, b) => a.sequence - b.sequence).map((group) => {
            const state = detail.build_groups.find((item) => item.group_id === group.id);
            const tasks = detail.wireframe!.plan.tasks.filter((task) => task.group_id === group.id).sort((a, b) => a.sequence - b.sequence);
            const done = tasks.filter((task) => detail.build_tasks.find((item) => item.task_id === task.id)?.status === 'done').length;
            return <section key={group.id} className="rounded-md border"><header className="flex items-center gap-3 border-b px-3 py-2"><span className="grid h-6 w-6 place-items-center rounded bg-muted text-xs font-semibold">{group.sequence}</span><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{group.name}</h3><p className="text-xs text-muted-foreground">{group.goal}</p></div><span className="text-xs text-muted-foreground">{done}/{tasks.length} · {group.complexity}</span><span className={cn('rounded px-2 py-0.5 text-[11px]', state?.status === 'approved' ? 'bg-green-500/15 text-green-600' : state?.status === 'review' ? 'bg-amber-500/15 text-amber-600' : 'bg-muted text-muted-foreground')}>{state?.status ?? 'pending'}</span></header><div className="divide-y">{tasks.map((task) => { const evidence = detail.build_tasks.find((item) => item.task_id === task.id); return <div key={task.id} className="flex items-center gap-2 px-3 py-2 text-xs">{evidence?.status === 'done' ? <Check className="h-3.5 w-3.5 text-green-600" /> : <CircleDot className="h-3.5 w-3.5 text-muted-foreground" />}<span className="flex-1">{task.title}</span><span className="text-muted-foreground">{task.kind}</span></div>; })}</div>{state?.status === 'review' && <footer className="flex justify-end gap-2 border-t p-2"><Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => void groupAction(group.id, 'reopen')}><RotateCcw className="mr-1 h-3 w-3" />{t('pipeline.requestChanges')}</Button><Button size="sm" className="h-7 text-xs" disabled={busy} onClick={() => void groupAction(group.id, 'approve')}>{busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Check className="mr-1 h-3 w-3" />}{t('pipeline.approve')}</Button></footer>}</section>;
          })}{wireframeStage?.status === 'review' && <div className="border-t pt-4"><ApproveBar busy={busy} onApprove={() => void stageAction('wireframe', 'approve')} onReopen={(feedback) => void stageAction('wireframe', 'reopen', feedback)} /></div>}</div>}</div>
        )}
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="flex h-full min-h-48 items-center justify-center text-sm text-muted-foreground">{text}</div>;
}
