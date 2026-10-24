import type { JsonSchema } from "@mcp/provider-sdk";
import { APP_PLAN_SCHEMA } from '@mcp/app-studio/plan/schema.js';
export const EMPTY: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };

export const PLAN_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    plan: { ...APP_PLAN_SCHEMA, description: 'Complete AppPlanV1 document.' },
    expected_revision_number: { type: 'integer', minimum: 1 },
    reason: { type: 'string' },
  },
  required: ['plan', 'reason'],
  additionalProperties: false,
};

export const UPSERT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    items: { type: 'array', minItems: 1, items: { type: 'object', properties: {
      id: { type: 'string' }, slice_id: { type: ['string', 'null'] }, title: { type: 'string' }, outcome: { type: 'string' },
      kind: { type: 'string', enum: ['research', 'plan', 'contract', 'implement', 'verify', 'release', 'change'] },
      owner_role: { type: 'string' }, priority: { type: 'integer' }, sort_order: { type: 'integer' },
      depends_on: { type: 'array', items: { type: 'string' } }, source_ids: { type: 'array', items: { type: 'string' } },
      acceptance: { type: 'array', items: { type: 'string' } }, file_scope: { type: 'array', items: { type: 'string' } },
    }, required: ['id', 'title', 'kind', 'owner_role', 'source_ids', 'acceptance'], additionalProperties: false } },
  },
  required: ['items'], additionalProperties: false,
};
