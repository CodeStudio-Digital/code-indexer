export interface AppPlanSchemaNode {
  type: 'object' | 'array' | 'string' | 'boolean' | 'integer';
  properties?: Record<string, AppPlanSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  items?: AppPlanSchemaNode;
  enum?: Array<string | number | boolean>;
  description?: string;
}

export interface AppPlanSchemaIssue {
  path: string;
  message: string;
}

type AppPlanDocumentValidation =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; issues: AppPlanSchemaIssue[] };

const text = (values?: string[]): AppPlanSchemaNode => ({
  type: 'string',
  ...(values ? { enum: values } : {}),
});
const bool = (): AppPlanSchemaNode => ({ type: 'boolean' });
const integer = (values?: number[]): AppPlanSchemaNode => ({
  type: 'integer',
  ...(values ? { enum: values } : {}),
});
const list = (items: AppPlanSchemaNode): AppPlanSchemaNode => ({ type: 'array', items });
const strings = (): AppPlanSchemaNode => list(text());
const object = (
  properties: Record<string, AppPlanSchemaNode>,
  optional: string[] = [],
): AppPlanSchemaNode => ({
  type: 'object',
  properties,
  required: Object.keys(properties).filter((name) => !optional.includes(name)),
  additionalProperties: false,
});

const identifiedText = object({ id: text(), text: text() });

/**
 * Canonical runtime and model-facing contract for AppPlanV1.
 *
 * Keep structural validation and the app_update_plan tool schema backed by
 * this same object so a model can never be shown a looser contract than the
 * one accepted before audit/persistence.
 */
export const APP_PLAN_SCHEMA: AppPlanSchemaNode = object({
  v: integer([1]),
  intent: object({
    summary: text(),
    audience: text(),
    locale: text(),
    goals: list(identifiedText),
    out_of_scope: list(identifiedText),
    assumptions: list(identifiedText),
    risks: list(identifiedText),
  }),
  scope: object({
    capabilities: list(object({
      id: text(),
      name: text(),
      description: text(),
      selected: bool(),
      critical: bool(),
      quality_attributes: strings(),
      source_ids: strings(),
    })),
    rules: list(object({ id: text(), text: text(), source_ids: strings() })),
    acceptance: list(object({ id: text(), text: text(), capability_ids: strings() })),
  }),
  experience: object({
    tone: text(),
    primary_color: text(),
    navigation: text(),
    screens: list(object({
      id: text(),
      name: text(),
      purpose: text(),
      route: text(),
      primary: bool(),
      protected: bool(),
      capability_ids: strings(),
      states: strings(),
    })),
    flows: list(object({
      id: text(),
      name: text(),
      capability_ids: strings(),
      steps: list(object({
        id: text(),
        screen_id: text(),
        action: text(),
        reads: strings(),
        writes: strings(),
      })),
    })),
  }, ['primary_color']),
  data: object({
    required: bool(),
    auth: object({ enabled: bool(), methods: strings() }),
    entities: list(object({
      id: text(),
      name: text(),
      label: text(),
      fields: list(object({
        name: text(),
        label: text(),
        type: text(['text', 'integer', 'real', 'boolean', 'timestamp', 'json']),
        required: bool(),
        unique: bool(),
        references: text(),
      }, ['references'])),
    })),
  }),
  engineering: object({
    stack_profile_id: text(['cf-fullstack-v1']),
    components: list(object({
      id: text(),
      kind: text(['spa', 'worker', 'd1', 'cache', 'queue', 'object-storage', 'durable-object']),
      name: text(),
      responsibility: text(),
      consumer_ids: strings(),
      source_ids: strings(),
    })),
    decisions: list(object({
      id: text(),
      title: text(),
      decision: text(),
      rationale: text(),
      source_ids: strings(),
    })),
    critical_writes: list(object({
      id: text(),
      capability_id: text(),
      entity: text(),
      idempotency: text(),
      consistency: text(),
      constraint: text(),
      test_id: text(),
    })),
    security: list(object({ id: text(), control: text(), source_ids: strings() })),
  }),
  delivery: object({
    slices: list(object({
      id: text(),
      name: text(),
      capability_ids: strings(),
      screen_ids: strings(),
      entity_ids: strings(),
      test_ids: strings(),
      depends_on: strings(),
    })),
    tests: list(object({
      id: text(),
      title: text(),
      kind: text(['database', 'worker', 'browser', 'e2e']),
      source_ids: strings(),
      expected: text(),
    })),
  }),
});

function childPath(parent: string, key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function actualType(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function inspectNode(
  schema: AppPlanSchemaNode,
  value: unknown,
  path: string,
  issues: AppPlanSchemaIssue[],
): void {
  const matches = schema.type === 'object'
    ? Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    : schema.type === 'array'
      ? Array.isArray(value)
      : schema.type === 'integer'
        ? typeof value === 'number' && Number.isInteger(value)
        : typeof value === schema.type;

  if (!matches) {
    issues.push({ path, message: `must be ${schema.type}; received ${actualType(value)}` });
    return;
  }

  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    issues.push({ path, message: `must be one of ${schema.enum.map(String).join(', ')}` });
    return;
  }

  if (schema.type === 'array') {
    const items = value as unknown[];
    if (schema.items) items.forEach((item, index) => inspectNode(schema.items!, item, `${path}[${index}]`, issues));
    return;
  }

  if (schema.type !== 'object') return;
  const record = value as Record<string, unknown>;
  const properties = schema.properties ?? {};
  for (const name of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(record, name)) {
      issues.push({ path: childPath(path, name), message: 'is required' });
    }
  }
  for (const [name, child] of Object.entries(properties)) {
    if (Object.prototype.hasOwnProperty.call(record, name)) {
      inspectNode(child, record[name], childPath(path, name), issues);
    }
  }
  if (schema.additionalProperties === false) {
    for (const name of Object.keys(record)) {
      if (!Object.prototype.hasOwnProperty.call(properties, name)) {
        issues.push({ path: childPath(path, name), message: 'is not allowed' });
      }
    }
  }
}

export function validateAppPlanDocument(
  input: string | unknown,
  rootPath = 'plan',
): AppPlanDocumentValidation {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      return { ok: false, issues: [{ path: rootPath, message: 'must be valid JSON' }] };
    }
  }

  const issues: AppPlanSchemaIssue[] = [];
  inspectNode(APP_PLAN_SCHEMA, value, rootPath, issues);
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: value as Record<string, unknown> };
}
