/**
 * Core PURO do "salvar spec" — compartilhado entre a tool `app_save_spec`
 * (agente) e a rota `PUT /api/app-studio/sessions/:id/spec` (modo
 * Blueprint). normalize → validate → serialize, preservando o workflow v5.
 * Sem fs/store aqui: os efeitos (persistir, espelhar arquivo, checar o
 * lock do gate de Escopo) ficam nos chamadores — o que mantém este módulo
 * testável e importável do browser.
 */
import type { AppSpec } from './types.js';
import { normalizeAppSpec } from './normalize.js';
import { findSpecTextEncodingIssues, sanitizeSpecText } from './text-quality.js';
import { validateAppSpec } from './validate.js';
import { serializeAppSpec } from './types.js';
import { upgradeAppSpecToV2 } from './stable-ids.js';

export type PrepareSpecSaveResult =
  | { ok: false; issues: string[] }
  | {
      ok: true;
      spec: AppSpec;
      /** JSON canônico p/ `app_studio_sessions.spec_json` (compacto). */
      specJson: string;
      /** JSON legível p/ o espelho `spec/app-spec.json` no workspace. */
      mirrorJson: string;
      /** Workflow v5 preservado; a spec não mantém um roadmap paralelo. */
      workflowJson: string | null;
    };

export function prepareSpecSave(rawSpec: unknown, workflowJson: string | null): PrepareSpecSaveResult {
  const normalized = normalizeAppSpec(sanitizeSpecText(rawSpec));
  const issues = [...validateAppSpec(normalized), ...findSpecTextEncodingIssues(normalized)];
  if (issues.length > 0) return { ok: false, issues };
  const spec = upgradeAppSpecToV2(normalized as AppSpec);

  return {
    ok: true,
    spec,
    specJson: JSON.stringify(spec),
    mirrorJson: serializeAppSpec(spec),
    workflowJson,
  };
}
