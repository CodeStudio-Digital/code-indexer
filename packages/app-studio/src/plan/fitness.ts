import { createHash } from 'node:crypto';
import { requireAppPlan, type AppFitnessCheck, type AppFitnessReport, type AppPlanV1 } from './types.js';

const SUPPORTED_COMPONENTS = new Set<AppPlanV1['engineering']['components'][number]['kind']>([
  'spa', 'worker', 'd1',
]);

function stableFingerprint(plan: AppPlanV1): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

function check(
  id: string,
  ok: boolean,
  severity: AppFitnessCheck['severity'],
  title: string,
  detail: string,
  sourceIds: string[] = [],
  action?: string,
): AppFitnessCheck {
  return { id, status: ok ? 'pass' : 'fail', severity, title, detail, source_ids: sourceIds, ...(action ? { action } : {}) };
}

export function auditAppPlan(input: unknown, now = new Date()): AppFitnessReport {
  const plan = requireAppPlan(input);
  const checks: AppFitnessCheck[] = [];
  const selected = plan.scope.capabilities.filter((item) => item.selected);
  const knownSources = new Set<string>([
    ...plan.intent.goals.map((item) => item.id),
    ...plan.scope.rules.map((item) => item.id),
    ...plan.scope.acceptance.map((item) => item.id),
    ...selected.map((item) => item.id),
    ...plan.experience.screens.map((item) => item.id),
    ...plan.data.entities.map((item) => item.id),
    ...plan.engineering.decisions.map((item) => item.id),
  ]);
  const consumerIds = new Set<string>([
    ...selected.map((item) => item.id),
    ...plan.experience.screens.map((item) => item.id),
    ...plan.data.entities.map((item) => item.id),
    ...plan.delivery.slices.map((item) => item.id),
  ]);

  checks.push(check(
    'intent.summary',
    plan.intent.summary.trim().length >= 20 && plan.intent.audience.trim().length > 0,
    'error',
    'Objetivo e público definidos',
    'O plano precisa explicar o resultado do app e para quem ele existe.',
    plan.intent.goals.map((item) => item.id),
    'Defina um resumo objetivo e o público principal.',
  ));
  checks.push(check(
    'scope.selected',
    selected.length > 0,
    'error',
    'Escopo selecionado',
    'Pelo menos uma capacidade deve estar no escopo atual.',
    selected.map((item) => item.id),
    'Selecione a menor capacidade que entrega valor real.',
  ));

  for (const capability of selected) {
    const screens = plan.experience.screens.filter((screen) => screen.capability_ids.includes(capability.id));
    const slices = plan.delivery.slices.filter((slice) => slice.capability_ids.includes(capability.id));
    const acceptance = plan.scope.acceptance.filter((item) => item.capability_ids.includes(capability.id));
    checks.push(check(
      `capability.${capability.id}.coverage`,
      screens.length > 0 && slices.length > 0 && acceptance.length > 0,
      'error',
      `Cobertura de ${capability.name}`,
      'Toda capacidade selecionada deve chegar a uma tela, slice e critério de aceite.',
      [capability.id, ...screens.map((item) => item.id), ...slices.map((item) => item.id), ...acceptance.map((item) => item.id)],
      'Vincule a capacidade à experiência, entrega e verificação.',
    ));
  }

  for (const component of plan.engineering.components) {
    const supported = SUPPORTED_COMPONENTS.has(component.kind);
    const justified = component.consumer_ids.length > 0
      && component.consumer_ids.every((id) => consumerIds.has(id))
      && component.source_ids.length > 0
      && component.source_ids.every((id) => knownSources.has(id));
    checks.push(check(
      `component.${component.id}.supported`,
      supported,
      'error',
      `${component.name} é provisionável`,
      supported ? 'O componente faz parte do perfil ativo.' : 'O stack atual não sabe criar ou operar este componente.',
      component.source_ids,
      supported ? undefined : 'Remova o componente ou adicione suporte real ao stack antes de construir.',
    ));
    checks.push(check(
      `component.${component.id}.justified`,
      justified,
      'error',
      `${component.name} tem propósito`,
      justified ? 'O componente possui consumidor e requisito rastreável.' : 'Componente sem consumidor ou requisito é over-engineering.',
      component.source_ids,
      justified ? undefined : 'Conecte-o a um requisito e consumidor reais ou remova-o.',
    ));
  }

  const protectedScreens = plan.experience.screens.filter((screen) => screen.protected);
  const authReady = protectedScreens.length === 0 || (
    plan.data.auth.enabled
    && plan.data.auth.methods.length > 0
    && plan.engineering.security.length > 0
  );
  checks.push(check(
    'security.authentication',
    authReady,
    'error',
    'Autenticação e segurança coerentes',
    protectedScreens.length === 0
      ? 'O plano não declara telas protegidas.'
      : 'Telas protegidas exigem método de autenticação e controles de segurança explícitos.',
    protectedScreens.map((screen) => screen.id),
    authReady ? undefined : 'Defina autenticação e controles para cada fluxo protegido.',
  ));

  const entityCoverage = plan.data.entities.filter((entity) => (
    !plan.delivery.slices.some((slice) => slice.entity_ids.includes(entity.id))
  ));
  checks.push(check(
    'data.delivery-coverage',
    !plan.data.required || (plan.data.entities.length > 0 && entityCoverage.length === 0),
    'error',
    'Dados cobertos pela entrega',
    'Cada entidade necessária deve pertencer a pelo menos um slice verificável.',
    entityCoverage.map((entity) => entity.id),
    entityCoverage.length > 0 ? 'Vincule as entidades restantes a slices e testes.' : undefined,
  ));

  const criticalCapabilities = selected.filter((item) => item.critical);
  for (const capability of criticalCapabilities) {
    const writes = plan.engineering.critical_writes.filter((item) => item.capability_id === capability.id);
    const complete = writes.length > 0 && writes.every((item) => (
      item.idempotency.trim() && item.consistency.trim() && item.constraint.trim()
      && plan.delivery.tests.some((test) => test.id === item.test_id)
    ));
    checks.push(check(
      `capability.${capability.id}.critical-write`,
      complete,
      'error',
      `Escritas críticas de ${capability.name}`,
      'Operações críticas precisam declarar idempotência, consistência, constraint e teste.',
      [capability.id, ...writes.map((item) => item.id)],
      'Defina a proteção contra repetição e concorrência destrutiva.',
    ));
  }

  const danglingTests = plan.delivery.tests.filter((test) => (
    test.source_ids.length === 0 || test.source_ids.some((id) => !knownSources.has(id))
  ));
  checks.push(check(
    'delivery.test-traceability',
    plan.delivery.tests.length > 0 && danglingTests.length === 0,
    'error',
    'Testes rastreáveis',
    'Os testes devem provar requisitos reais da revisão atual.',
    danglingTests.flatMap((item) => item.source_ids),
    'Ligue cada teste a uma fonte válida do plano.',
  ));

  const allIds = [
    ...plan.intent.goals.map((item) => item.id),
    ...plan.intent.out_of_scope.map((item) => item.id),
    ...plan.intent.assumptions.map((item) => item.id),
    ...plan.intent.risks.map((item) => item.id),
    ...plan.scope.capabilities.map((item) => item.id),
    ...plan.scope.rules.map((item) => item.id),
    ...plan.scope.acceptance.map((item) => item.id),
    ...plan.experience.screens.map((item) => item.id),
    ...plan.experience.flows.map((item) => item.id),
    ...plan.data.entities.map((item) => item.id),
    ...plan.engineering.components.map((item) => item.id),
    ...plan.engineering.decisions.map((item) => item.id),
    ...plan.engineering.critical_writes.map((item) => item.id),
    ...plan.engineering.security.map((item) => item.id),
    ...plan.delivery.slices.map((item) => item.id),
    ...plan.delivery.tests.map((item) => item.id),
  ];
  const duplicateIds = [...new Set(allIds.filter((id, index) => allIds.indexOf(id) !== index))];
  const duplicateRoutes = plan.experience.screens
    .map((screen) => screen.route)
    .filter((route, index, routes) => routes.indexOf(route) !== index);
  checks.push(check(
    'truth.unique-identities',
    duplicateIds.length === 0 && duplicateRoutes.length === 0,
    'error',
    'Uma fonte de verdade',
    'IDs e rotas precisam ser únicos dentro do documento canônico.',
    duplicateIds,
    duplicateIds.length || duplicateRoutes.length ? 'Remova identidades e rotas duplicadas.' : undefined,
  ));

  const uncoveredRisks = plan.intent.risks.filter((risk) => (
    !plan.engineering.decisions.some((decision) => decision.source_ids.includes(risk.id))
  ));
  checks.push(check(
    'risk.decisions',
    uncoveredRisks.length === 0,
    'warning',
    'Riscos possuem decisão',
    'Riscos relevantes devem apontar para uma decisão ou mitigação técnica.',
    uncoveredRisks.map((risk) => risk.id),
    uncoveredRisks.length > 0 ? 'Decida como tratar cada risco antes de construir.' : undefined,
  ));

  const queueLike = plan.engineering.components.filter((item) => item.kind === 'queue');
  for (const component of queueLike) {
    const consumedBySlice = plan.delivery.slices.some((slice) => (
      slice.id === component.consumer_ids[0]
      || component.consumer_ids.some((id) => slice.id === id || slice.capability_ids.includes(id))
    ));
    checks.push(check(
      `component.${component.id}.consumer`,
      consumedBySlice,
      'error',
      `${component.name} possui consumidor assíncrono`,
      'Fila sem slice ou capacidade consumidora é infraestrutura decorativa.',
      component.source_ids,
      consumedBySlice ? undefined : 'Remova a fila ou modele o consumidor e seu teste.',
    ));
  }

  const failures = checks.filter((item) => item.status === 'fail');
  const errors = failures.filter((item) => item.severity === 'error').length;
  const warnings = failures.filter((item) => item.severity === 'warning').length;
  return {
    v: 1,
    status: errors > 0 ? 'blocked' : warnings > 0 ? 'needs_decision' : 'ready',
    plan_fingerprint: stableFingerprint(plan),
    checked_at: now.toISOString(),
    checks,
    counts: { passed: checks.length - failures.length, warnings, errors },
  };
}
