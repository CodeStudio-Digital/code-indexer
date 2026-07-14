/**
 * Client das rotas do modo Blueprint (PUT spec / PUT layout). O PUT spec
 * devolve 400 {issues} (inválida) e 409 {code:'spec_locked'} (Escopo
 * aprovado — a UI cria uma revisão versionada).
 */
import type { AppSpec } from '@mcp/app-studio/spec/types.js';
import type { BlueprintLayout } from '@mcp/app-studio/blueprint/types.js';

export class SpecSaveError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
    readonly locked = false,
  ) {
    super(message);
  }
}

export async function putAppSpec(sessionId: number, spec: AppSpec): Promise<void> {
  const r = await fetch(`/api/app-studio/sessions/${sessionId}/spec`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spec }),
  });
  if (r.ok) return;
  const body = (await r.json().catch(() => ({}))) as { issues?: string[]; code?: string; error?: string };
  throw new SpecSaveError(body.error ?? r.statusText, body.issues ?? [], body.code === 'spec_locked');
}

export async function putBlueprintLayout(sessionId: number, layout: BlueprintLayout): Promise<void> {
  const r = await fetch(`/api/app-studio/sessions/${sessionId}/blueprint`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ layout }),
  });
  if (!r.ok) throw new Error((await r.text().catch(() => r.statusText)) || r.statusText);
}
