/**
 * Tool: `app_save_spec`. Materializa a entrevista em uma AppSpec validada:
 * issues do validador voltam para o agente corrigir (o leigo nunca vê
 * JSON); sucesso grava spec_json + espelho legível `spec/app-spec.json`
 * no workspace e (re)constrói o roadmap do pipeline.
 *
 * Depois que discovery é aprovada, a mesma chamada degrada com segurança para
 * uma revisão versionada: nunca sobrescreve o contrato vigente e o usuário
 * continua aprovando a mudança no painel de versões.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { appResult } from './model-output.js';
import type { AppToolBinding } from '@mcp/company/tools/app-studio/binding.js';
import { getAppStudioStore } from '@mcp/company/tools/app-studio/store-binding.js';
import { resolveHostPath } from '@mcp/company/tools/design-system/ds-publish-version.js';
import { prepareSpecSave } from '@mcp/app-studio/spec/save-core.js';
import { parsePipelineState } from '@mcp/app-studio/pipeline/stages.js';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import { diffAppSpecs, impactFromSpecDiff, specDiffHasChanges, summarizeSpecDiff } from '@mcp/app-studio/spec/revisions.js';

// Full JSON Schema for the spec — constrains the model's tool call AND
// documents the EXACT shape (the old `type:object` hint made the model guess
// field names/enums and fail repeatedly). Field names are code identifiers;
// `label` fields are human names in the user's language.
export const APP_SPEC_TOOL_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    v: { type: 'number', enum: [1] },
    summary: { type: 'string', description: 'One sentence: what the app does.' },
    audience: { type: 'string', description: 'Who uses it.' },
    locale: { type: 'string', description: "The user's language tag, e.g. 'pt-BR'." },
    features: {
      type: 'array',
      description: 'Each feature is an OBJECT (not a string).',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'kebab-case, e.g. "gestao-pedidos".' },
          name: { type: 'string', description: "Human name in the user's language." },
          description: { type: 'string' },
          screen_ids: { type: 'array', items: { type: 'string' }, description: 'Screen ids this feature appears on (may be empty).' },
        },
        required: ['id', 'name', 'description', 'screen_ids'],
      },
    },
    screens: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'kebab-case, e.g. "lista-pedidos".' },
          name: { type: 'string', description: 'PascalCase component name, e.g. "OrdersScreen".' },
          label: { type: 'string', description: "Human name in the user's language." },
          purpose: { type: 'string', description: 'What the user does on this screen.' },
          primary: { type: 'boolean', description: 'EXACTLY ONE screen must set primary:true (the home route).' },
        },
        required: ['id', 'name', 'label', 'purpose'],
      },
    },
    database: {
      type: 'object',
      properties: {
        required: { type: 'boolean' },
        entities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'snake_case table name, e.g. "pedidos".' },
              label: { type: 'string', description: "Human name in the user's language." },
              fields: {
                type: 'array',
                description: 'Each field is an OBJECT (not a string).',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'snake_case column name.' },
                    label: { type: 'string' },
                    type: { type: 'string', enum: ['text', 'integer', 'real', 'timestamp'] },
                    required: { type: 'boolean' },
                    references: { type: 'string', description: 'Referenced entity name (logical FK).' },
                  },
                  required: ['name', 'label', 'type'],
                },
              },
            },
            required: ['name', 'label', 'fields'],
          },
        },
      },
      required: ['required', 'entities'],
    },
    auth: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        methods: {
          type: 'array',
          description: "ONLY these values: 'password', 'oauth-google', 'oauth-github'.",
          items: { type: 'string', enum: ['password', 'oauth-google', 'oauth-github'] },
        },
        protected_screen_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['enabled'],
    },
    design: {
      type: 'object',
      properties: {
        tone: { type: 'string' },
        primary_color: { type: 'string' },
      },
      required: ['tone'],
    },
    requirements: {
      type: 'object',
      description:
        'OPTIONAL product refinement. Use it to capture goals, acceptance criteria, rules, scope limits, assumptions, and risks in the user language.',
      properties: {
        goals: { type: 'array', items: { type: 'string' } },
        business_rules: { type: 'array', items: { type: 'string' } },
        acceptance_criteria: { type: 'array', items: { type: 'string' } },
        out_of_scope: { type: 'array', items: { type: 'string' } },
        assumptions: { type: 'array', items: { type: 'string' } },
        risks: { type: 'array', items: { type: 'string' } },
      },
    },
    behaviors: {
      type: 'array',
      description:
        'OPTIONAL flow rules ("ao enviar o formulário → salvar em pedidos → mostrar aviso"). Each is implemented by you in the backend stage.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'kebab-case, unique.' },
          screen_id: { type: 'string', description: 'Screen where the trigger lives.' },
          trigger: { type: 'string', enum: ['click', 'submit', 'open'] },
          trigger_label: { type: 'string', description: "Human description in the user's language." },
          actions: {
            type: 'array',
            description: '≥1, in order. kinds: save{entity} | navigate{screen_id} | notify{message}.',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['save', 'navigate', 'notify'] },
                entity: { type: 'string' },
                screen_id: { type: 'string' },
                message: { type: 'string' },
              },
              required: ['kind'],
            },
          },
        },
        required: ['id', 'screen_id', 'trigger', 'trigger_label', 'actions'],
      },
    },
  },
  required: ['v', 'summary', 'audience', 'locale', 'features', 'screens', 'database', 'auth', 'design'],
};

const SPEC_EXAMPLE = `{
  "v": 1,
  "summary": "Gerencia os pedidos da lanchonete",
  "audience": "dona de lanchonete",
  "locale": "pt-BR",
  "features": [
    { "id": "gestao-pedidos", "name": "Gestão de pedidos", "description": "criar e acompanhar pedidos", "screen_ids": ["painel"] }
  ],
  "screens": [
    { "id": "painel", "name": "PainelScreen", "label": "Painel de pedidos", "purpose": "ver e criar pedidos", "primary": true }
  ],
  "database": {
    "required": true,
    "entities": [
      { "name": "pedidos", "label": "Pedidos", "fields": [
        { "name": "cliente", "label": "Nome do cliente", "type": "text", "required": true },
        { "name": "total", "label": "Valor total", "type": "real" }
      ] }
    ]
  },
  "auth": { "enabled": true, "methods": ["password", "oauth-google"] },
  "design": { "tone": "clean e amigável" },
  "requirements": {
    "goals": ["A dona acompanha pedidos abertos sem planilha externa"],
    "acceptance_criteria": ["Criar pedido com cliente e total", "Ver pedidos recentes no painel"],
    "business_rules": ["Pedido novo começa com status aberto"],
    "out_of_scope": ["Integração com delivery nesta primeira versão"]
  },
  "behaviors": [
    { "id": "salvar-pedido", "screen_id": "painel", "trigger": "submit",
      "trigger_label": "ao enviar o formulário de pedido",
      "actions": [
        { "kind": "save", "entity": "pedidos" },
        { "kind": "notify", "message": "Pedido salvo!" }
      ] }
  ]
}`;

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    spec: {
      ...APP_SPEC_TOOL_SCHEMA,
      description:
        'The complete AppSpec v1 object. CRITICAL SHAPE (the tool rejects wrong shapes): `features` and `database.entities[].fields` are ARRAYS OF OBJECTS, never strings. Every screen needs `id` (kebab-case) + `purpose`, and EXACTLY ONE screen has `primary:true`. `auth.methods` uses ONLY "password" | "oauth-google" | "oauth-github". Example:\n' +
        'Text quality: use valid UTF-8 text in the user language. Never send replacement characters (U+FFFD) or mojibake like "Ã§", "Ã£", "â€™"; rewrite the affected sentence before saving. Example:\n' +
        SPEC_EXAMPLE,
    },
  },
  required: ['spec'],
};

export function appSaveSpec(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_save_spec',
    description:
      'Validate and save the app spec. During discovery it updates the draft and roadmap. After discovery is approved it safely creates a reviewable versioned revision instead of overwriting the approved plan.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async (args, ctx) => {
      try {
        const store = getAppStudioStore();
        if (!store) return err('app_save_spec: AppStudioStore not wired.');
        const session = binding.resolveAppSession(store);
        if (!session) return err(`No AppStudioSession bound to ${binding.describeBinding()}.`);

        const state = parsePipelineState(session.pipeline_json);
        const discovery = state?.stages.find((s) => s.id === 'discovery');
        // Core compartilhado (normalize→validate→serialize→roadmap) — a rota
        // PUT spec do modo Blueprint usa o MESMO caminho.
        const prepared = prepareSpecSave(args.spec, session.pipeline_json);
        if (!prepared.ok) {
          return err(
            ['Spec validation failed — fix every issue and call app_save_spec again:', ...prepared.issues.map((i) => `  - ${i}`)].join('\n'),
          );
        }
        const { spec } = prepared;

        if (discovery?.status === 'approved') {
          const baseRevision = store.getLatestApprovedSpecRevision(session.id) ?? store.ensureInitialSpecRevision(session.id);
          if (!baseRevision) return err('Approved discovery has no base spec revision. Reopen and approve discovery once to repair the version history.');
          const diff = diffAppSpecs(parseAppSpec(baseRevision.spec_json), spec);
          if (!specDiffHasChanges(diff)) {
            return ok('The submitted spec is identical to the approved version. No revision was created.');
          }
          const impact = impactFromSpecDiff(diff);
          const summary = summarizeSpecDiff(diff);
          const evolution = store.findOpenEvolution(session.id) ?? store.createEvolution({
            app_session_id: session.id,
            title: 'Refinamento do plano',
            description: 'Mudanca proposta pelo especialista de requisitos.',
            base_revision_id: baseRevision.id,
          });
          const revision = store.createSpecRevision({
            app_session_id: session.id,
            status: 'draft',
            title: evolution.title,
            summary: summary.join('\n'),
            change_reason: evolution.description,
            spec_json: prepared.specJson,
            base_revision_id: baseRevision.id,
            diff_json: JSON.stringify(diff),
            impact_json: JSON.stringify(impact),
            created_by: 'agent',
          });
          store.updateEvolution(evolution.id, {
            status: 'review',
            proposed_revision_id: revision.id,
            impact_json: JSON.stringify(impact),
            submitted_at: evolution.submitted_at ?? new Date().toISOString(),
          });
          return appResult('App spec revision proposed', {
            mode: 'versioned_revision',
            revision: { id: revision.id, number: revision.revision_number, status: revision.status },
            impact,
            summary,
            next: 'The approved spec was not overwritten. Explain the changes and ask the user to review them in Versoes/Mudancas.',
          });
        }

        store.setSpecJson(session.id, prepared.specJson);
        if (prepared.pipelineJson) store.setPipelineJson(session.id, prepared.pipelineJson);

        // Espelho legível no workspace (o leigo pode abrir; o agente relê).
        const resolved = resolveHostPath('spec/app-spec.json', ctx);
        if (resolved.kind === 'ok') {
          mkdirSync(dirname(resolved.path), { recursive: true });
          writeFileSync(resolved.path, prepared.mirrorJson, 'utf8');
        }

        return ok(
          `Spec saved: ${spec.screens.length} screen(s), ` +
            `${spec.database.required ? `${spec.database.entities.length} entity(ies)` : 'no database'}, ` +
            `auth ${spec.auth.enabled ? 'ON' : 'off'}, ${spec.behaviors?.length ?? 0} behavior(s). Roadmap rebuilt. ` +
            'Recap the plan to the user in THEIR language; iterate with more app_save_spec calls until they confirm, ' +
            "then submit with app_submit_stage({ stage: 'discovery', ... }).",
        );
      } catch (e) {
        return err(`app_save_spec failed: ${(e as Error).message}`);
      }
    },
  };
}
