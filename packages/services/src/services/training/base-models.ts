/**
 * Curated catalog of QLoRA-ready base models (Unsloth 4-bit variants), with the
 * VRAM each needs to TRAIN. The UI filters/recommends by detected GPU; users can
 * also pass a custom HF repo id. `hfRepo` is what reaches the Python trainer via
 * `--base-model`.
 */
export interface BaseModel {
  id: string;
  label: string;
  /** HuggingFace repo id (Unsloth 4-bit build) passed to train.py. */
  hfRepo: string;
  /** Param count label, e.g. '7B'. */
  params: string;
  /** Minimum GPU VRAM (MB) for a comfortable QLoRA run at seq 2048. */
  minVramMb: number;
}

export const BASE_MODELS: BaseModel[] = [
  {
    id: 'qwen2.5-coder-7b',
    label: 'Qwen2.5-Coder 7B (recommended)',
    hfRepo: 'unsloth/Qwen2.5-Coder-7B-bnb-4bit',
    params: '7B',
    minVramMb: 9_500,
  },
  {
    id: 'deepseek-coder-6.7b',
    label: 'DeepSeek-Coder 6.7B',
    hfRepo: 'unsloth/deepseek-coder-6.7b-instruct-bnb-4bit',
    params: '6.7B',
    minVramMb: 9_000,
  },
  {
    id: 'qwen2.5-coder-3b',
    label: 'Qwen2.5-Coder 3B',
    hfRepo: 'unsloth/Qwen2.5-Coder-3B-bnb-4bit',
    params: '3B',
    minVramMb: 6_000,
  },
  {
    id: 'qwen2.5-coder-1.5b',
    label: 'Qwen2.5-Coder 1.5B (fastest)',
    hfRepo: 'unsloth/Qwen2.5-Coder-1.5B-bnb-4bit',
    params: '1.5B',
    minVramMb: 4_000,
  },
];

export function getBaseModel(id: string): BaseModel | undefined {
  return BASE_MODELS.find((m) => m.id === id);
}

/** Resolve a base selection to an HF repo: a catalog id, or a raw HF repo id. */
export function resolveBaseRepo(idOrRepo: string): string {
  return getBaseModel(idOrRepo)?.hfRepo ?? idOrRepo;
}

/** Models that comfortably fit the detected VRAM (with a safety margin). */
export function modelsForVram(vramMb: number): BaseModel[] {
  return BASE_MODELS.filter((m) => m.minVramMb <= vramMb);
}

/** Best default for the detected VRAM (largest that fits), else the smallest. */
export function recommendedModel(vramMb: number): BaseModel {
  const fit = modelsForVram(vramMb).sort((a, b) => b.minVramMb - a.minVramMb);
  return fit[0] ?? BASE_MODELS[BASE_MODELS.length - 1];
}
