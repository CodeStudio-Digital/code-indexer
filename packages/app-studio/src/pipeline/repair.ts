import type { AppSpec } from '../spec/types.js';
import { buildFeatureRoadmap } from './roadmap.js';
import {
  APP_STAGE_IDS,
  createPipelineState,
  type AppPipelineStage,
  type AppPipelineState,
  type AppStageId,
  type AppStageStatus,
} from './stages.js';

export interface AppPipelineRepairEvidence {
  spec: AppSpec | null;
  approvedSpecRevisionId: number | null;
  architecture: {
    revisionId: number;
    status: 'draft' | 'approved' | 'superseded' | 'rejected';
    specRevisionId: number | null;
    auditOk: boolean;
  } | null;
  ux?: {
    revisionId: number;
    status: 'draft' | 'approved' | 'superseded' | 'rejected';
    specRevisionId: number | null;
    architectureRevisionId: number | null;
    dataFingerprint: string;
    auditOk: boolean;
  } | null;
  wireframe?: {
    status: 'draft' | 'approved' | 'superseded' | 'rejected';
    specRevisionId: number | null;
    architectureRevisionId: number | null;
    uxRevisionId: number | null;
    dataFingerprint: string;
    auditOk: boolean;
  } | null;
  currentDataFingerprint?: string;
  deployHealthy: boolean;
}

export interface AppPipelineRepairIssue {
  code: 'missing-pipeline' | 'missing-stage' | 'duplicate-stage' | 'invalid-order' | 'invalid-skip' | 'missing-evidence' | 'stale-roadmap';
  severity: 'warning' | 'error';
  stage_id: AppStageId | null;
  message: string;
}

export interface AppPipelineRepairChange {
  stage_id: AppStageId | null;
  before: AppStageStatus | 'missing' | 'outdated';
  after: AppStageStatus | 'rebuilt';
  reason: string;
}

export interface AppPipelineRepairReport {
  changed: boolean;
  issues: AppPipelineRepairIssue[];
  changes: AppPipelineRepairChange[];
  pipeline: AppPipelineState;
}

const complete = (status: AppStageStatus): boolean => status === 'approved' || status === 'skipped';

function resetAs(stage: AppPipelineStage, status: AppStageStatus, feedback: string | null = null): void {
  stage.status = status;
  stage.summary = null;
  stage.gate = null;
  stage.feedback = feedback;
  stage.submitted_at = null;
  stage.approved_at = null;
}

function copyStage(target: AppPipelineStage, source: AppPipelineStage, status: AppStageStatus): void {
  Object.assign(target, source, { id: target.id, status });
  if (status !== 'approved') target.approved_at = null;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stageReason(id: AppStageId, before: AppStageStatus | 'missing', after: AppStageStatus): string {
  if (id === 'architecture' && before === 'skipped' && after === 'active') {
    return 'A arquitetura virou obrigatoria e nao possui uma versao aprovada para a spec atual.';
  }
  if (before === 'missing') return 'A etapa obrigatoria estava ausente e foi restaurada.';
  if (after === 'pending') return 'Uma etapa anterior precisa ser confirmada antes de continuar.';
  if (after === 'active') return 'Esta e a primeira etapa sem evidencia confiavel de conclusao.';
  if (after === 'approved') return 'A aprovacao persistida foi recuperada a partir das evidencias versionadas.';
  if (after === 'skipped') return 'A spec confirma que esta etapa nao e necessaria.';
  return 'O status foi alinhado com as evidencias persistidas.';
}

export function repairAppPipeline(
  state: AppPipelineState | null,
  evidence: AppPipelineRepairEvidence,
): AppPipelineRepairReport {
  const issues: AppPipelineRepairIssue[] = [];
  const changes: AppPipelineRepairChange[] = [];
  const next = createPipelineState();
  next.roadmap = evidence.spec ? buildFeatureRoadmap(evidence.spec) : [];

  if (!state) {
    issues.push({ code: 'missing-pipeline', severity: 'error', stage_id: null, message: 'A jornada nao existe ou nao pode ser lida.' });
  }

  const occurrences = new Map<AppStageId, AppPipelineStage[]>();
  for (const stage of state?.stages ?? []) {
    if (!APP_STAGE_IDS.includes(stage.id)) continue;
    const list = occurrences.get(stage.id) ?? [];
    list.push(stage);
    occurrences.set(stage.id, list);
  }
  for (const id of APP_STAGE_IDS) {
    const count = occurrences.get(id)?.length ?? 0;
    if (count === 0) issues.push({ code: 'missing-stage', severity: 'error', stage_id: id, message: `A etapa '${id}' estava ausente.` });
    if (count > 1) issues.push({ code: 'duplicate-stage', severity: 'error', stage_id: id, message: `A etapa '${id}' aparecia ${count} vezes.` });
  }

  const old = (id: AppStageId): AppPipelineStage | null => occurrences.get(id)?.[0] ?? null;
  const oldDiscovery = old('discovery');
  const trustedDiscovery = !!evidence.spec && (
    evidence.approvedSpecRevisionId != null || oldDiscovery?.status === 'approved'
  );

  const discovery = next.stages[0]!;
  if (trustedDiscovery) {
    if (oldDiscovery) copyStage(discovery, oldDiscovery, 'approved');
    else discovery.status = 'approved';
  } else if (oldDiscovery?.status === 'review' && oldDiscovery.gate?.ok && evidence.spec) {
    copyStage(discovery, oldDiscovery, 'review');
  } else if (oldDiscovery?.status === 'pending') {
    copyStage(discovery, oldDiscovery, 'pending');
  } else {
    resetAs(discovery, 'active', oldDiscovery?.status === 'approved' ? 'A aprovacao antiga nao tinha uma spec valida; revise esta etapa.' : null);
    if (oldDiscovery?.status === 'approved') {
      issues.push({ code: 'missing-evidence', severity: 'error', stage_id: 'discovery', message: 'A etapa estava aprovada sem uma spec valida.' });
    }
  }

  const oldArchitecture = old('architecture');
  const architecture = next.stages[1]!;
  const architectureMatchesSpec = !!evidence.architecture && (
    evidence.approvedSpecRevisionId == null
      ? evidence.architecture.specRevisionId == null
      : evidence.architecture.specRevisionId === evidence.approvedSpecRevisionId
  );
  const trustedArchitecture = evidence.architecture?.status === 'approved' && evidence.architecture.auditOk && architectureMatchesSpec;
  const downstreamStarted = APP_STAGE_IDS.slice(2).some((id) => old(id)?.status !== 'pending' && old(id) != null);

  if (!complete(discovery.status)) {
    resetAs(architecture, 'pending');
  } else if (trustedArchitecture) {
    if (oldArchitecture) copyStage(architecture, oldArchitecture, 'approved');
    else architecture.status = 'approved';
  } else if (oldArchitecture?.status === 'review' && oldArchitecture.gate?.ok && evidence.architecture?.auditOk && architectureMatchesSpec) {
    copyStage(architecture, oldArchitecture, 'review');
  } else if (oldArchitecture?.status === 'active') {
    copyStage(architecture, oldArchitecture, 'active');
  } else if (oldArchitecture?.status === 'pending' && !downstreamStarted) {
    copyStage(architecture, oldArchitecture, 'pending');
  } else {
    resetAs(architecture, 'active', 'Jornada reparada: confirme como o app sera construido antes de continuar.');
    if (oldArchitecture?.status === 'skipped') {
      issues.push({ code: 'invalid-skip', severity: 'error', stage_id: 'architecture', message: 'Arquitetura estava marcada como desnecessaria, mas agora e uma etapa obrigatoria.' });
    } else if (oldArchitecture?.status === 'approved') {
      issues.push({ code: 'missing-evidence', severity: 'error', stage_id: 'architecture', message: 'Arquitetura estava aprovada sem uma versao valida para a spec atual.' });
    }
  }

  for (let index = 2; index < APP_STAGE_IDS.length; index += 1) {
    const id = APP_STAGE_IDS[index]!;
    const target = next.stages[index]!;
    const source = old(id);
    const previous = next.stages[index - 1]!;
    if (!complete(previous.status)) {
      resetAs(target, 'pending');
      continue;
    }
    if (id === 'database' && evidence.spec?.database.required === false) {
      if (source) copyStage(target, source, 'skipped');
      else target.status = 'skipped';
      continue;
    }
    const trustedUx = id === 'ux' && evidence.ux?.status === 'approved' && evidence.ux.auditOk
      && evidence.ux.specRevisionId === evidence.approvedSpecRevisionId
      && evidence.ux.architectureRevisionId === (evidence.architecture?.revisionId ?? null)
      && evidence.ux.dataFingerprint === (evidence.currentDataFingerprint ?? evidence.ux.dataFingerprint);
    const trustedWireframe = id === 'wireframe' && evidence.wireframe?.status === 'approved' && evidence.wireframe.auditOk
      && evidence.wireframe.specRevisionId === evidence.approvedSpecRevisionId
      && evidence.wireframe.architectureRevisionId === (evidence.architecture?.revisionId ?? null)
      && evidence.wireframe.uxRevisionId === (evidence.ux?.revisionId ?? null)
      && evidence.wireframe.dataFingerprint === (evidence.currentDataFingerprint ?? evidence.wireframe.dataFingerprint);
    if (trustedUx || trustedWireframe) {
      if (source) copyStage(target, source, 'approved');
      else target.status = 'approved';
      continue;
    }
    if (source?.status === 'approved') {
      const trusted = id === 'launch' ? evidence.deployHealthy : source.gate?.ok === true;
      if (trusted) {
        copyStage(target, source, 'approved');
        continue;
      }
      issues.push({ code: 'missing-evidence', severity: 'error', stage_id: id, message: `A etapa '${id}' estava aprovada sem evidencia valida.` });
      resetAs(target, 'active', 'Jornada reparada: confira esta etapa novamente.');
      continue;
    }
    if (source?.status === 'review' && source.gate?.ok) {
      copyStage(target, source, 'review');
      continue;
    }
    if (source?.status === 'active') {
      copyStage(target, source, 'active');
      continue;
    }
    if (source?.status === 'skipped') {
      issues.push({ code: 'invalid-skip', severity: 'error', stage_id: id, message: `A etapa obrigatoria '${id}' estava marcada como desnecessaria.` });
      resetAs(target, 'active', 'Jornada reparada: esta etapa precisa ser conferida.');
      continue;
    }
    if (source) copyStage(target, source, 'pending');
    else if (id === 'ux') resetAs(target, 'active', 'Complete a direção de experiência antes de revisar as telas existentes.');
  }

  let foundIncomplete = false;
  for (const stage of next.stages) {
    if (foundIncomplete && stage.status !== 'pending') {
      issues.push({ code: 'invalid-order', severity: 'error', stage_id: stage.id, message: `A etapa '${stage.id}' estava adiantada em relacao a uma etapa anterior.` });
      resetAs(stage, 'pending');
    }
    if (!complete(stage.status)) foundIncomplete = true;
  }

  if (state && !sameJson(state.roadmap, next.roadmap)) {
    issues.push({ code: 'stale-roadmap', severity: 'warning', stage_id: null, message: 'A lista de telas e recursos nao correspondia mais a spec atual.' });
    changes.push({ stage_id: null, before: 'outdated', after: 'rebuilt', reason: 'O progresso foi recalculado pela spec atual sem apagar arquivos.' });
  }

  for (const id of APP_STAGE_IDS) {
    const before = old(id)?.status ?? 'missing';
    const after = next.stages.find((stage) => stage.id === id)!.status;
    if (before !== after) changes.push({ stage_id: id, before, after, reason: stageReason(id, before, after) });
  }

  return {
    changed: !state || !sameJson(state, next),
    issues,
    changes,
    pipeline: next,
  };
}
