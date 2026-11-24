import { z } from 'zod';

const text = z.string().trim().max(8000);
const id = z.string().trim().min(1).max(160);
const projectIds = z.array(z.number().int().positive()).max(50);
const key = z.string().regex(/^[\p{L}\p{N}_-]{1,80}$/u);
export const designRole = z.object({
  role: key,
  responsibility: text,
  provider: z.string().max(160),
  model: z.string().max(250),
  effort: z.string().max(25),
  skills: z.array(id).max(64),
  projectIds,
  readOnly: z.boolean(),
});
export const designTask = z.object({
  id: key,
  title: z.string().trim().min(1).max(250),
  description: text,
  owner: z.string().max(80),
  projectId: z.number().int().positive().nullable(),
  criteria: z
    .array(z.string().trim().max(500))
    .max(30)
    .transform((rows) => rows.filter(Boolean)),
  dependsOn: z.array(key).max(30),
});
export const designPlan = z.object({
  name: z.string().trim().max(160),
  goal: text,
  projectIds,
  roles: z.array(designRole).max(24),
  tasks: z.array(designTask).max(30),
  rules: text,
  concurrency: z.number().int().min(1).max(32).nullable(),
  visualQA: z.boolean(),
});
export type DesignPlan = z.infer<typeof designPlan>;
export type DesignRole = z.infer<typeof designRole>;
export type DesignTask = z.infer<typeof designTask>;
export const designSections = designPlan.keyof().options;
export type DesignSection = (typeof designSections)[number];
export const blankPlan = (): DesignPlan => ({
  name: '',
  goal: '',
  projectIds: [],
  roles: [],
  tasks: [],
  rules: '',
  concurrency: null,
  visualQA: false,
});
export function newRole(name: string, provider = '', model = ''): DesignRole {
  return {
    role: name,
    responsibility: '',
    provider,
    model,
    effort: '',
    skills: [],
    projectIds: [],
    readOnly: false,
  };
}
export const designPin = z
  .string()
  .max(180)
  .refine((value) => {
    const [section, id, field, ...rest] = value.split(':');
    if (rest.length) return false;
    if (id === undefined) return designSections.some((k) => k === section);
    if (!key.safeParse(id).success) return false;
    if (section === 'roles') return field === undefined || Object.hasOwn(designRole.shape, field);
    return section === 'tasks' && (field === undefined || Object.hasOwn(designTask.shape, field));
  });

function protectRows<T extends object>(
  group: string,
  current: T[],
  proposed: T[],
  pins: string[],
  identify: (row: T) => string,
): T[] {
  const originals = new Map(current.map((row) => [identify(row), row]));
  const fields = new Map<string, string[]>();
  for (const pin of pins) {
    const [section, id, field] = pin.split(':');
    if (section === group && id) fields.set(id, [...(fields.get(id) ?? []), field ?? '*']);
  }
  const rows: T[] = [];
  for (const row of proposed) {
    const id = identify(row),
      pinned = fields.get(id),
      saved = originals.get(id);
    if (!pinned) rows.push(row);
    else if (saved)
      rows.push(
        pinned.includes('*')
          ? saved
          : Object.assign({}, row, Object.fromEntries(pinned.map((k) => [k, saved[k as keyof T]]))),
      );
    originals.delete(id);
  }
  for (const [id, row] of originals) if (fields.has(id)) rows.push(row);
  return rows;
}

/** Protect individual decisions even when the model rewrites a collection. */
export function protectDesignPins(
  draft: Pick<DesignDraft, 'plan' | 'pins'>,
  proposed: Partial<DesignPlan>,
): Partial<DesignPlan> {
  const changes = { ...proposed };
  for (const section of designSections) if (draft.pins.includes(section)) delete changes[section];
  if (changes.roles)
    changes.roles = protectRows('roles', draft.plan.roles, changes.roles, draft.pins, (r) => r.role);
  if (changes.tasks)
    changes.tasks = protectRows('tasks', draft.plan.tasks, changes.tasks, draft.pins, (t) => t.id);
  return changes;
}
export interface DesignProposal {
  baseRevision: number;
  request: string;
  reply: string;
  changes: Partial<DesignPlan>;
}
export interface DesignDraft {
  id: string;
  revision: number;
  source: { id: string; configRevision: string } | null;
  plan: DesignPlan;
  schemaVersion?: 1;
  advisor?: { provider: string; model: string };
  pins: string[];
  history: Array<{ request: string; reply: string }>;
  apply: { key: string; companyId: string; cardIds: Record<string, string>; done: boolean } | null;
}
export type DecisionMode = 'inherit' | 'off' | 'shadow' | 'suggest';
