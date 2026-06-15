/**
 * Visual-edit endpoint handler: deterministic, no-AI source rewrite for a
 * stamped element of a Builder project (inline text + Tailwind classes).
 * Thin validation over `@mcp/services/builder-edit/apply.js` — the engine
 * owns parsing, reserved-file guards and the optimistic-concurrency
 * contract (`expectFileHash`/`newLoc` chaining).
 */
import { ApiError } from '@mcp/api-bus';
import { applyVisualEdit, type VisualEditOp } from '@mcp/services/builder-edit/apply.js';
import type { HandlerDeps } from '../types.js';

export interface VisualEditBody {
  /** Stamp loc — `relpath:line:col` from `data-mcp-loc`. */
  loc: string;
  op: VisualEditOp;
  expectTag?: string;
  expectFileHash?: string;
}

export interface VisualEditOkResult {
  ok: true;
  /** Fresh stamp loc for the SAME element after the rewrite shifted positions. */
  newLoc: string;
  /** Optimistic-concurrency token for the next chained edit. */
  fileHash: string;
}

function parseOp(raw: unknown): VisualEditOp | null {
  if (!raw || typeof raw !== 'object') return null;
  const op = raw as { kind?: unknown; classes?: unknown; text?: unknown };
  if (op.kind === 'set-classes' && typeof op.classes === 'string') {
    return { kind: 'set-classes', classes: op.classes };
  }
  if (op.kind === 'set-text' && typeof op.text === 'string') {
    return { kind: 'set-text', text: op.text };
  }
  return null;
}

export function visualEdit(deps: HandlerDeps, id: number, body: Partial<VisualEditBody>): VisualEditOkResult {
  const project = deps.db.getProject(id);
  if (!project) throw new ApiError('not_found', 404, 'project not found');
  if (!project.builder_json) {
    throw new ApiError('not_builder', 400, 'project is not a Builder project');
  }
  if (typeof body.loc !== 'string' || !body.loc.trim()) {
    throw new ApiError('bad_request', 400, 'loc is required');
  }
  const op = parseOp(body.op);
  if (!op) throw new ApiError('bad_request', 400, 'op must be set-classes{classes} or set-text{text}');

  const result = applyVisualEdit({
    projectRoot: project.root_path,
    loc: body.loc.trim(),
    op,
    expectTag: typeof body.expectTag === 'string' ? body.expectTag : undefined,
    expectFileHash: typeof body.expectFileHash === 'string' ? body.expectFileHash : undefined,
  });

  if (!result.ok) {
    // 409 = stale selection (file moved on under us); 422 = shape we refuse
    // to edit deterministically (dynamic className, mixed children, …).
    throw new ApiError(result.stale ? 'stale_selection' : 'not_editable', result.stale ? 409 : 422, result.reason);
  }
  return { ok: true, newLoc: result.newLoc, fileHash: result.fileHash };
}
