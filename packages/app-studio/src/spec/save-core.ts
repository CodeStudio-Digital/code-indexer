/**
 * Core PURO do "salvar spec" — compartilhado entre a tool `app_save_spec`
 * (agente) e a rota `PUT /api/app-studio/sessions/:id/spec` (modo
 * Blueprint). normalize → validate → serialize → roadmap reconstruído.
 * Sem fs/store aqui: os efeitos (persistir, espelhar arquivo, checar o
 * lock do discovery) ficam nos chamadores — o que mantém este módulo
 * testável e importável do browser.
 */
import type { AppSpec } from './types.js';
import { normalizeAppSpec } from './normalize.js';
import { findSpecTextEncodingIssues, sanitizeSpecText } from './text-quality.js';
import { validateAppSpec } from './validate.js';
import { serializeAppSpec } from './types.js';
import {
  parsePipelineState,
  replaceRoadmap,
  serializePipelineState,
} from '../pipeline/stages.js';
import { buildFeatureRoadmap } from '../pipeline/roadmap.js';

export type PrepareSpecSaveResult =
  | { ok: false; issues: string[] }
  | {
      ok: true;
      spec: AppSpec;
      /** JSON canônico p/ `app_studio_sessions.spec_json` (compacto). */
      specJson: string;
      /** JSON legível p/ o espelho `spec/app-spec.json` no workspace. */
      mirrorJson: string;
      /** pipeline_json com o roadmap reconstruído; null se o input era null/inválido. */
      pipelineJson: string | null;
    };

export function prepareSpecSave(rawSpec: unknown, pipelineJson: string | null): PrepareSpecSaveResult {
  const normalized = normalizeAppSpec(sanitizeSpecText(rawSpec));
  const issues = [...validateAppSpec(normalized), ...findSpecTextEncodingIssues(normalized)];
  if (issues.length > 0) return { ok: false, issues };
  const spec = normalized as AppSpec;

  const state = parsePipelineState(pipelineJson);
  const nextPipeline = state
    ? serializePipelineState(replaceRoadmap(state, buildFeatureRoadmap(spec)))
    : null;

  return {
    ok: true,
    spec,
    specJson: JSON.stringify(spec),
    mirrorJson: serializeAppSpec(spec),
    pipelineJson: nextPipeline,
  };
}
