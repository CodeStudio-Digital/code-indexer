import type { AppSpec } from '../spec/types.js';
import type { AppProductCapability, AppProductComplexity, AppProductModel, AppProductScenario } from './types.js';

function slug(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
}

export function classifyProductComplexity(spec: AppSpec): { complexity: AppProductComplexity; factors: string[] } {
  const factors: string[] = [];
  const corpus = JSON.stringify(spec).toLowerCase();
  if (spec.screens.length >= 8) factors.push(`${spec.screens.length} telas conectadas`);
  if (spec.database.entities.length >= 15) factors.push(`${spec.database.entities.length} entidades persistentes`);
  if ((spec.behaviors?.length ?? 0) >= 12) factors.push(`${spec.behaviors?.length ?? 0} comportamentos`);
  if (/multiplayer|tempo real|real-time|ao vivo|concorr/.test(corpus)) factors.push('concorrência ou tempo real');
  if (/finance|pagamento|saldo|contrato|transfer/.test(corpus)) factors.push('regras financeiras ou contratuais');
  if (/permiss|papel|role|auth|login/.test(corpus)) factors.push('papéis e acesso protegido');
  if (/reconex|offline|recuper/.test(corpus)) factors.push('recuperação e reconexão');
  const score = factors.length + (spec.database.entities.length >= 30 ? 2 : 0) + (spec.screens.length >= 10 ? 1 : 0);
  return { complexity: score >= 7 ? 'very-complex' : score >= 4 ? 'complex' : score >= 2 ? 'standard' : 'simple', factors: factors.length ? factors : ['escopo concentrado e sem sinais críticos de complexidade'] };
}

function basicScenarios(capability: AppProductCapability): AppProductScenario[] {
  const base = (kind: AppProductScenario['kind'], suffix: string, when: string, then: string): AppProductScenario => ({
    id: `${capability.id}-${suffix}`, capability_id: capability.id, kind, title: `${capability.name}: ${suffix.replaceAll('-', ' ')}`,
    given: ['O usuário está no contexto correto para esta capacidade.'], when, then: [then], source_ids: capability.rule_ids,
  });
  const result = [base('success', 'sucesso', `O usuário executa ${capability.name}.`, 'O resultado esperado é persistido e comunicado claramente.')];
  if (capability.critical) result.push(
    base('validation-error', 'erro-validacao', 'O usuário envia dados inválidos ou incompletos.', 'A operação é rejeitada sem corromper estado.'),
    base('permission', 'sem-permissao', 'Um usuário sem permissão tenta executar a operação.', 'O acesso é negado sem expor dados protegidos.'),
    base('state-transition', 'transicao-estado', 'A operação altera o estado principal.', 'A transição segue as regras e mantém histórico rastreável.'),
  );
  return result;
}

function footballSuggestions(spec: AppSpec): AppProductCapability[] {
  const corpus = JSON.stringify(spec).toLowerCase();
  if (!/futebol|football|jogador|clube|campeonato/.test(corpus)) return [];
  const suggestions = [
    ['training', 'Treinos e desenvolvimento', 'Planejar sessões, carga e evolução dos atletas.', 'complete'],
    ['staff', 'Comissão técnica', 'Contratar e coordenar auxiliares, preparadores e médicos.', 'complete'],
    ['academy', 'Categorias de base', 'Descobrir e desenvolver jovens atletas.', 'future'],
    ['scouting', 'Observação e conhecimento', 'Controlar alcance, relatórios e incerteza sobre atletas.', 'complete'],
    ['relationships', 'Relações e moral', 'Modelar promessas, hierarquia, satisfação e conflitos.', 'complete'],
    ['board', 'Diretoria e objetivos', 'Definir metas, confiança, orçamento e prestação de contas.', 'complete'],
    ['media', 'Imprensa e narrativa', 'Tratar entrevistas, notícias e repercussão pública.', 'future'],
    ['facilities', 'Infraestrutura do clube', 'Evoluir instalações, custos e efeitos esportivos.', 'future'],
    ['analytics', 'Análise e estatísticas avançadas', 'Comparar desempenho, tendências e decisões táticas.', 'complete'],
  ] as const;
  return suggestions.map(([id, name, description, horizon]) => ({
    id: `proposed-${id}`, domain_id: 'product-expansion', name, description, horizon, provenance: 'inferred', selected: false,
    critical: false, rationale: 'Capacidade comum em simuladores de gestão completos; requer decisão explícita antes de entrar no escopo.',
    actor_ids: ['primary-user'], rule_ids: [], entity_names: [], screen_ids: [], quality_attributes: [], research_source_ids: [],
  }));
}

export function recoverProductModel(spec: AppSpec, baseSpecRevisionId: number | null): AppProductModel {
  const classification = classifyProductComplexity(spec);
  const capabilities: AppProductCapability[] = spec.features.map((feature, index) => ({
    id: `cap-${slug(feature.id || feature.name)}`, domain_id: `domain-${slug(feature.id || feature.name)}`, name: feature.name,
    description: feature.description, horizon: 'core', provenance: 'existing', selected: true, critical: feature.screen_ids.length > 1,
    rationale: 'Capacidade já presente na spec aprovada.', actor_ids: ['primary-user'], rule_ids: [`feature:${feature.id || index}`],
    entity_names: [], screen_ids: feature.screen_ids, quality_attributes: [], research_source_ids: [],
  }));
  const proposed = footballSuggestions(spec);
  if (proposed.length) capabilities.push(...proposed);
  const domains = spec.features.map((feature) => ({
    id: `domain-${slug(feature.id || feature.name)}`, name: feature.name, description: feature.description,
    capability_ids: [`cap-${slug(feature.id || feature.name)}`],
  }));
  if (proposed.length) domains.push({ id: 'product-expansion', name: 'Profundidade opcional do produto', description: 'Capacidades sugeridas para o usuário avaliar, sem inclusão automática.', capability_ids: proposed.map((item) => item.id) });
  return {
    v: 1, base_spec_revision_id: baseSpecRevisionId, summary: spec.summary, complexity: classification.complexity,
    complexity_factors: classification.factors,
    personas: [{ id: 'primary-user', name: spec.audience || 'Usuário principal', goals: spec.requirements?.goals ?? [spec.summary], permissions: spec.auth.enabled ? ['Acessar áreas autenticadas permitidas'] : ['Usar o aplicativo'] }],
    domains, capabilities, scenarios: capabilities.filter((item) => item.selected).flatMap(basicScenarios),
    journeys: spec.screens.filter((screen) => screen.primary).map((screen) => ({ id: `journey-${screen.id}`, name: `Jornada principal: ${screen.label}`, actor_id: 'primary-user', capability_ids: capabilities.filter((item) => item.screen_ids.includes(screen.id)).map((item) => item.id), outcome: screen.purpose })),
    non_functional_requirements: classification.complexity === 'complex' || classification.complexity === 'very-complex' ? ['Consistência transacional das regras críticas', 'Acessibilidade WCAG 2.2 AA', 'Recuperação segura após falhas'] : ['Acessibilidade WCAG 2.2 AA'],
    assumptions: spec.requirements?.assumptions ?? [], risks: spec.requirements?.risks ?? [], decisions: proposed.length ? [{ id: 'scope-depth', question: 'Manter o núcleo atual ou ampliar para um produto mais completo?', status: 'open', blocking: true, decision: null }] : [],
    research_sources: [], candidate_spec: spec,
  };
}
