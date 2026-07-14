/**
 * Leitor estritamente de migração para o formato persistido antes do workflow v5.
 * Nenhuma transição antiga vive aqui: o resultado só pode ser convertido uma vez.
 */
export interface LegacyAppPipelineStage {
  id: string;
  status: 'pending' | 'active' | 'review' | 'approved' | 'skipped';
}

export interface LegacyAppPipelineState {
  v: 1 | 2 | 3 | 4;
  stages: LegacyAppPipelineStage[];
}

const LEGACY_STAGE_IDS = [
  'discovery', 'product', 'architecture', 'database', 'ux', 'wireframe',
  'design', 'backend', 'review', 'launch',
] as const;

export function emptyLegacyPipeline(): LegacyAppPipelineState {
  return {
    v: 4,
    stages: LEGACY_STAGE_IDS.map((id) => ({ id, status: 'pending' })),
  };
}

export function parseLegacyPipeline(json: string | null | undefined): LegacyAppPipelineState | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Partial<LegacyAppPipelineState>;
    if (![1, 2, 3, 4].includes(value.v as number) || !Array.isArray(value.stages)) return null;
    const stages = value.stages.flatMap((stage) => {
      if (!stage || typeof stage.id !== 'string') return [];
      if (!['pending', 'active', 'review', 'approved', 'skipped'].includes(stage.status)) return [];
      return [{ id: stage.id, status: stage.status } satisfies LegacyAppPipelineStage];
    });
    return stages.length > 0 ? { v: value.v as LegacyAppPipelineState['v'], stages } : null;
  } catch {
    return null;
  }
}
