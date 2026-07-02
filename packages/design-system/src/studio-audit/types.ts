/**
 * Tipos do studio-audit — a camada de verificação de qualidade de design do
 * DS Studio (irmã do package-audit, que cuida do SHAPE do pacote). Cada
 * issue nomeia arquivo e conserto: o consumidor é o próprio agente.
 */

export type StudioCheckId =
  | 'token_coverage'
  | 'theme_fidelity'
  | 'gallery_coverage'
  | 'variant_coverage'
  | 'docs_depth'
  | 'a11y';

export interface StudioAuditIssue {
  check: StudioCheckId;
  code: string;
  message: string;
  file?: string;
  line?: number;
}

export interface StudioAuditResult {
  ok: boolean;
  errors: StudioAuditIssue[];
  warnings: StudioAuditIssue[];
  /** Métricas por check (cobertura 0..1 etc.) para badges/telemetria. */
  metrics: Partial<Record<StudioCheckId, number>>;
}

export interface StudioThresholds {
  /** Fração mínima de referências token vs literais de cor. */
  minTokenCoverage: number;
  /** Distância RGB ponderada máxima p/ um token contar como "do tema". */
  fidelityColorTolerance: number;
  /** Saturação mínima p/ um token de cor ser cobrado na fidelidade. */
  fidelityMinSaturation: number;
  /** Chars mínimos de uma seção de docs por componente. */
  minDocsSectionChars: number;
}

export const DEFAULT_THRESHOLDS: StudioThresholds = {
  minTokenCoverage: 0.98,
  fidelityColorTolerance: 24,
  fidelityMinSaturation: 0.08,
  minDocsSectionChars: 200,
};

export interface StudioAuditInput {
  /** Raiz do workspace no host (contém pkg/, app/, import/). */
  workspaceDir: string;
  stack: 'react-ts' | 'vue-ts' | 'angular';
  mode: 'fidelity' | 'creative';
  /** Componentes registrados (draft ∪ última publicada). */
  recorded: Array<{ name: string; kind: string; props_schema_json?: string | null }>;
  /** Subconjunto de checks a rodar; ausente = todos. */
  checks?: StudioCheckId[];
  /** 'stage' relaxa alguns veredictos (unrecorded export vira warning). */
  scope: 'stage' | 'publish';
  thresholds?: Partial<StudioThresholds>;
}
