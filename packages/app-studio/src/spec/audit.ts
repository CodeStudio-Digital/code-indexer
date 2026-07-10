import type { AppSpec } from './types.js';
import { validateAppSpec } from './validate.js';

export type SpecAuditSeverity = 'info' | 'warning' | 'error';
export type SpecAuditArea = 'overview' | 'requirements' | 'screens' | 'features' | 'data' | 'auth' | 'actions';

export interface SpecAuditIssue {
  id: string;
  severity: SpecAuditSeverity;
  area: SpecAuditArea;
  title: string;
  detail: string;
}

export interface SpecAuditReport {
  score: number;
  issues: SpecAuditIssue[];
  counts: Record<SpecAuditSeverity, number>;
}

function words(text: string | undefined): number {
  return (text ?? '').trim().split(/\s+/).filter(Boolean).length;
}

function push(
  issues: SpecAuditIssue[],
  severity: SpecAuditSeverity,
  area: SpecAuditArea,
  id: string,
  title: string,
  detail: string,
): void {
  issues.push({ severity, area, id, title, detail });
}

function listSize(value: string[] | undefined): number {
  return Array.isArray(value) ? value.filter((x) => x.trim()).length : 0;
}

export function auditAppSpec(spec: AppSpec): SpecAuditReport {
  const issues: SpecAuditIssue[] = [];

  const validationIssues = validateAppSpec(spec);
  validationIssues.forEach((detail, index) => {
    push(issues, 'error', 'overview', `validation-${index}`, 'Spec invalida', detail);
  });

  if (words(spec.summary) < 6) {
    push(
      issues,
      'warning',
      'overview',
      'summary-too-short',
      'Resumo muito curto',
      'Explique em uma frase clara o problema resolvido, o usuario e o resultado esperado.',
    );
  }

  if (words(spec.audience) < 2) {
    push(
      issues,
      'warning',
      'overview',
      'audience-too-short',
      'Publico pouco definido',
      'Diga quem usa o app e em qual contexto. Ex.: donos de clubes pequenos, atendentes, gestores.',
    );
  }

  const requirements = spec.requirements;
  if (!requirements) {
    push(
      issues,
      'warning',
      'requirements',
      'requirements-missing',
      'Requisitos finos ausentes',
      'Adicione objetivos, criterios de aceite, regras de negocio e o que fica fora desta versao.',
    );
  } else {
    if (listSize(requirements.goals) === 0) {
      push(issues, 'warning', 'requirements', 'goals-missing', 'Objetivos ausentes', 'Liste os resultados que o app precisa entregar.');
    }
    if (listSize(requirements.acceptance_criteria) === 0) {
      push(
        issues,
        'warning',
        'requirements',
        'acceptance-missing',
        'Criterios de aceite ausentes',
        'Defina como o usuario saberá que cada fluxo principal esta pronto.',
      );
    }
    if (listSize(requirements.business_rules) === 0 && spec.database.required) {
      push(
        issues,
        'info',
        'requirements',
        'rules-missing',
        'Regras de negocio nao declaradas',
        'Para apps com dados, registre regras como status inicial, permissao, calculos e validacoes.',
      );
    }
    if (listSize(requirements.out_of_scope) === 0) {
      push(
        issues,
        'info',
        'requirements',
        'scope-missing',
        'Fora de escopo nao declarado',
        'Dizer o que nao entra evita que o build tente entregar recursos alem da primeira versao.',
      );
    }
  }

  const featureScreenIds = new Set<string>();
  for (const feature of spec.features) {
    if (feature.screen_ids.length === 0) {
      push(
        issues,
        'warning',
        'features',
        `feature-${feature.id}-no-screen`,
        `Recurso sem tela: ${feature.name}`,
        'Associe o recurso a uma tela ou deixe claro que ele e apenas API/automacao.',
      );
    }
    feature.screen_ids.forEach((id) => featureScreenIds.add(id));
  }

  for (const screen of spec.screens) {
    if (!featureScreenIds.has(screen.id)) {
      push(
        issues,
        'warning',
        'screens',
        `screen-${screen.id}-unlinked`,
        `Tela sem recurso: ${screen.label}`,
        'Conecte a tela a um recurso para o agente entender por que ela existe.',
      );
    }
    if (words(screen.purpose) < 4) {
      push(
        issues,
        'info',
        'screens',
        `screen-${screen.id}-purpose-short`,
        `Finalidade curta: ${screen.label}`,
        'Explique a tarefa principal feita nesta tela para orientar layout e backend.',
      );
    }
  }

  if (spec.database.required && spec.database.entities.length === 0) {
    push(issues, 'error', 'data', 'database-required-empty', 'Banco sem entidades', 'Modele os dados que o app precisa guardar.');
  }

  const entityNames = new Set(spec.database.entities.map((entity) => entity.name));
  for (const entity of spec.database.entities) {
    if (entity.fields.length <= 1) {
      push(
        issues,
        'warning',
        'data',
        `entity-${entity.name}-few-fields`,
        `Dados pouco detalhados: ${entity.label}`,
        'Adicione os campos essenciais que o usuario espera ver, filtrar ou preencher.',
      );
    }
    for (const field of entity.fields) {
      if (field.name.endsWith('_id') && !field.references) {
        push(
          issues,
          'warning',
          'data',
          `field-${entity.name}-${field.name}-missing-reference`,
          `FK sem relacionamento: ${entity.label}.${field.label}`,
          'Campos terminados em _id normalmente precisam apontar para outro tipo de dado.',
        );
      }
      if (field.references && !entityNames.has(field.references)) {
        push(
          issues,
          'error',
          'data',
          `field-${entity.name}-${field.name}-unknown-reference`,
          `Relacionamento desconhecido: ${field.label}`,
          `A entidade "${field.references}" nao existe na spec.`,
        );
      }
      if (field.references && field.type !== 'integer') {
        push(
          issues,
          'warning',
          'data',
          `field-${entity.name}-${field.name}-reference-type`,
          `Tipo de FK suspeito: ${field.label}`,
          'Relacionamentos devem usar tipo numero para ficarem coerentes com IDs.',
        );
      }
    }
  }

  if (spec.auth.enabled) {
    if (!spec.auth.methods?.length) {
      push(issues, 'error', 'auth', 'auth-methods-missing', 'Login sem metodo', 'Escolha senha, Google ou GitHub.');
    }
    if (!spec.auth.protected_screen_ids?.length) {
      push(
        issues,
        'warning',
        'auth',
        'auth-no-protected-screens',
        'Login sem telas protegidas',
        'Marque quais telas exigem login para evitar app aberto por acidente.',
      );
    }
  }

  const behaviors = spec.behaviors ?? [];
  if (behaviors.length === 0 && spec.screens.length > 0 && (spec.database.required || spec.screens.length > 1)) {
    push(
      issues,
      'warning',
      'actions',
      'behaviors-missing',
      'Acoes do usuario ausentes',
      'Declare pelo menos os fluxos principais: enviar formulario, salvar dados, navegar e mostrar aviso.',
    );
  }
  const screenIds = new Set(spec.screens.map((screen) => screen.id));
  for (const behavior of behaviors) {
    if (behavior.actions.length === 0) {
      push(
        issues,
        'error',
        'actions',
        `behavior-${behavior.id}-empty`,
        `Acao sem resultado: ${behavior.trigger_label}`,
        'Uma acao precisa salvar, navegar ou avisar o usuario.',
      );
    }
    if (!screenIds.has(behavior.screen_id)) {
      push(
        issues,
        'error',
        'actions',
        `behavior-${behavior.id}-unknown-screen`,
        `Acao em tela desconhecida: ${behavior.trigger_label}`,
        `A tela "${behavior.screen_id}" nao existe.`,
      );
    }
    for (const action of behavior.actions) {
      if (action.kind === 'save' && !entityNames.has(action.entity)) {
        push(
          issues,
          'error',
          'actions',
          `behavior-${behavior.id}-unknown-save-${action.entity}`,
          `Salvar em dado desconhecido: ${action.entity}`,
          'A acao de salvar precisa apontar para uma entidade existente.',
        );
      }
      if (action.kind === 'navigate' && !screenIds.has(action.screen_id)) {
        push(
          issues,
          'error',
          'actions',
          `behavior-${behavior.id}-unknown-navigate-${action.screen_id}`,
          `Navegacao para tela desconhecida: ${action.screen_id}`,
          'A acao de navegar precisa apontar para uma tela existente.',
        );
      }
    }
  }

  const counts: Record<SpecAuditSeverity, number> = { info: 0, warning: 0, error: 0 };
  for (const issue of issues) counts[issue.severity] += 1;
  const score = Math.max(0, 100 - counts.error * 20 - counts.warning * 8 - counts.info * 3);
  return { score, issues, counts };
}
