import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Check, CircleDot, ListChecks, Palette, Workflow } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { cn } from '../../../lib/utils.js';
import type { AppStudioSessionDetail } from '../app-studio-api.js';

type ExperienceView = 'direction' | 'flows' | 'wireframes' | 'plan';

export function ExperiencePanel({ detail }: {
  detail: AppStudioSessionDetail;
  onChanged: () => void;
}) {
  const { t } = useTranslation('appStudio');
  const [view, setView] = useState<ExperienceView>('direction');
  const [selectedFlow, setSelectedFlow] = useState(detail.wireframe?.plan.flows[0]?.id ?? null);
  const [selectedScreen, setSelectedScreen] = useState(detail.wireframe?.plan.screens[0]?.screen_id ?? null);

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
  const buildSlices = detail.workflow.work_items.filter((item) => item.phase === 'build').reduce<Record<string, typeof detail.workflow.work_items>>((groups, item) => {
    const key = item.slice_id ?? t('workflow.unsliced');
    (groups[key] ??= []).push(item);
    return groups;
  }, {});

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
      </header>
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
            <aside className="hidden w-72 shrink-0 overflow-auto border-l p-3 text-xs lg:block">{wireframe && <><h3 className="font-semibold">{t('experience.dataBindings')}</h3>{wireframe.data_bindings.map((binding) => <div key={`${binding.entity}-${binding.purpose}`} className="mt-2 border-b pb-2"><strong>{binding.entity}</strong><p className="text-muted-foreground">{binding.fields.join(', ')}</p><p>{binding.fixture_scenario}</p></div>)}<h3 className="mt-4 font-semibold">{t('experience.states')}</h3><div className="mt-1 flex flex-wrap gap-1">{wireframe.states.map((state) => <span key={state} className="rounded bg-muted px-1.5 py-0.5">{state}</span>)}</div><h3 className="mt-4 font-semibold">{t('experience.responsive')}</h3><p className="mt-1 text-muted-foreground">{wireframe.responsive}</p></>}</aside>
          </div>
        )}
        {view === 'plan' && (
          <div className="h-full overflow-auto p-4">{Object.keys(buildSlices).length === 0 ? <Empty text={t('experience.noPlan')} /> : <div className="space-y-3">{Object.entries(buildSlices).map(([slice, tasks]) => <section key={slice} className="rounded-md border"><header className="border-b px-3 py-2"><h3 className="text-sm font-semibold">{slice}</h3><p className="text-xs text-muted-foreground">{tasks.filter((item) => item.status === 'done').length}/{tasks.length}</p></header><div className="divide-y">{tasks.map((task) => <div key={task.id} className="flex items-center gap-2 px-3 py-2 text-xs">{task.status === 'done' ? <Check className="h-3.5 w-3.5 text-green-600" /> : <CircleDot className="h-3.5 w-3.5 text-muted-foreground" />}<span className="flex-1">{task.title}</span><span className="text-muted-foreground">{task.status}</span></div>)}</div></section>)}</div>}</div>
        )}
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="flex h-full min-h-48 items-center justify-center text-sm text-muted-foreground">{text}</div>;
}
