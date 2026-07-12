import type { AppArchitecturePlan } from '../architecture/types.js';
import type { AppSpec } from '../spec/types.js';
import { dataModelFingerprint, type AppBuildTask, type AppUxBrief, type AppWireframePlan, type AppWireframeTestCase } from './types.js';

const fallbackPrimary = '#2563eb';

export function recoveredUxDraft(
  spec: AppSpec,
  links: { specRevisionId: number | null; architectureRevisionId: number | null },
): AppUxBrief {
  const primary = spec.design.primary_color || fallbackPrimary;
  return {
    v: 1,
    spec_revision_id: links.specRevisionId,
    architecture_revision_id: links.architectureRevisionId,
    data_fingerprint: dataModelFingerprint(spec),
    summary: `Rascunho recuperado de ${spec.design.tone}. Revise as três direções com o especialista antes de aprovar.`,
    directions: [
      { id: 'tema-atual', name: 'Evolução do tema atual', rationale: `Preserva ${spec.design.tone} e organiza a interface para ${spec.audience}.`, palette: [primary, '#0f172a', '#f8fafc'], typography: 'Sans-serif clara com números tabulares', density: 'comfortable' },
      { id: 'operacional', name: 'Centro de comando', rationale: 'Prioriza leitura rápida, comparação de dados e ações recorrentes.', palette: ['#0f172a', '#22c55e', '#e2e8f0'], typography: 'Sans-serif compacta com hierarquia forte', density: 'compact' },
      { id: 'acessivel', name: 'Clareza guiada', rationale: 'Reduz carga visual e conduz pessoas menos experientes pelas decisões importantes.', palette: ['#ffffff', '#1d4ed8', '#111827'], typography: 'Sans-serif altamente legível', density: 'spacious' },
    ],
    selected_direction_id: '',
    tokens: {
      background: '#0b1220', surface: '#111827', text: '#f8fafc', muted: '#94a3b8', primary, secondary: '#334155', accent: '#38bdf8', success: '#22c55e', warning: '#f59e0b', danger: '#ef4444', font_display: 'Inter, system-ui, sans-serif', font_body: 'Inter, system-ui, sans-serif', radius: '6px', spacing: '4px', density: 'comfortable', motion: '150ms ease; respeitar prefers-reduced-motion',
    },
    navigation: 'A definir com o especialista a partir dos fluxos principais.',
    principles: ['Mostrar primeiro a decisão mais importante', 'Manter contexto entre telas', 'Explicar estados e bloqueios em linguagem simples'],
    constraints: ['Não usar decoração que reduza a legibilidade dos dados'],
    rejected_directions: [],
    accessibility: { standard: 'WCAG 2.2 AA', contrast: 'Contraste AA em texto e controles', keyboard: 'Fluxos completos por teclado', focus: 'Foco sempre visível', reduced_motion: 'Animações desativáveis' },
    references: [],
  };
}

export function recoveredWireframeDraft(
  spec: AppSpec,
  architecture: AppArchitecturePlan | null,
  links: { specRevisionId: number | null; architectureRevisionId: number | null; uxRevisionId: number | null },
): AppWireframePlan {
  const flows = spec.screens.map((screen) => {
    const behaviors = (spec.behaviors ?? []).filter((behavior) => behavior.screen_id === screen.id);
    return {
      id: `flow-${screen.id}`,
      name: screen.label,
      actor: spec.audience,
      goal: screen.purpose,
      entry_screen_id: screen.id,
      source_ids: behaviors.map((behavior) => `behavior:${behavior.id}`),
      steps: [{ id: `${screen.id}-open`, screen_id: screen.id, action: `Abrir ${screen.label}`, result: screen.purpose, reads: [], writes: behaviors.flatMap((behavior) => behavior.actions.filter((action) => action.kind === 'save').map((action) => action.kind === 'save' ? action.entity : '')).filter(Boolean), next_step_ids: [] }],
    };
  });
  const tddCases: AppWireframeTestCase[] = (architecture?.tdd.cases ?? []).filter((item) => item.owner_stage === 'design').map((item) => ({
    id: `wf-${item.id}`, title: item.title, architecture_case_ids: [item.id], source_ids: item.source_ids,
    flow_ids: [], screen_ids: [], preconditions: item.preconditions, steps: item.steps, expected: item.expected,
  }));
  const buildGroups = spec.screens.map((screen, index) => ({
    id: `group-${screen.id}`, name: screen.label, goal: screen.purpose, sequence: index + 1, complexity: 'medium' as const,
    flow_ids: [`flow-${screen.id}`], capability_ids: [], screen_ids: [screen.id], depends_on: index === 0 ? [] : [`group-${spec.screens[index - 1]!.id}`],
    task_ids: ['test-red', 'mock-contract', 'screen', 'responsive', 'accessibility', 'test-green', 'preview'].map((kind) => `${screen.id}-${kind}`),
  }));
  const tasks: AppBuildTask[] = [];
  for (const [groupIndex, group] of buildGroups.entries()) {
    const screenId = group.screen_ids[0]!;
    const kinds = ['test-red', 'mock-contract', 'screen', 'responsive', 'accessibility', 'test-green', 'preview'] as const;
    kinds.forEach((kind, index) => tasks.push({ id: `${screenId}-${kind}`, group_id: group.id, screen_id: screenId, kind, title: `${kind}: ${group.name}`, sequence: groupIndex * 10 + index + 1, complexity: kind === 'screen' ? 'medium' : 'small', depends_on: index === 0 ? [] : [`${screenId}-${kinds[index - 1]}`], tdd_case_ids: tddCases.filter((item) => item.screen_ids.includes(screenId)).map((item) => item.id), entity_names: [], source_ids: [] }));
  }
  return {
    v: 1, spec_revision_id: links.specRevisionId, architecture_revision_id: links.architectureRevisionId, ux_revision_id: links.uxRevisionId,
    data_fingerprint: dataModelFingerprint(spec), summary: 'Rascunho recuperado da spec e da arquitetura; refine fluxos, bindings, testes e grupos antes de aprovar.',
    flows,
    screens: spec.screens.map((screen) => ({ screen_id: screen.id, route: screen.primary ? '/' : `/${screen.id}`, flow_ids: [`flow-${screen.id}`], hierarchy: [screen.label], regions: [{ id: 'main', purpose: screen.purpose, components: [] }], actions: (spec.behaviors ?? []).filter((behavior) => behavior.screen_id === screen.id).map((behavior) => behavior.trigger_label), data_bindings: [], states: ['populated', 'empty', 'error'], responsive: 'Definir comportamento mobile e desktop.', accessibility: ['Ordem de foco e nomes acessíveis a definir.'] })),
    tdd_cases: tddCases, build_groups: buildGroups, tasks,
  };
}
