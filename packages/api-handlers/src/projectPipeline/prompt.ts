/**
 * Builds the system + user prompt that turns a natural-language workflow
 * description into a pipeline graph JSON. Kept separate from the call/parse
 * logic so the prompt can evolve without touching provider plumbing.
 */

export interface PipelinePromptCtx {
  /** Scope decides whether `role` is constrained to a known set. */
  scope: 'company' | 'project';
  /** Company roles the graph may reference; ignored for project scope. */
  availableRoles: string[];
}

const SHAPE = `{
  "summary": string,                 // one sentence describing the pipeline
  "nodes": [{
    "id": string,                    // unique slug, e.g. "investigate"
    "label": string,                 // short human title
    "role": string,                  // a short role slug
    "kind": "agent" | "validate",    // validate = verdict-only stage
    "taskTemplate": string,          // prompt; may use the placeholders below
    "branchMode": "linear" | "pass-fail",
    "validatorPrompt"?: string       // required when kind="validate"
  }],
  "edges": [{
    "id": string,
    "kind": "linear" | "pass-fail",
    "from": string,                  // source node id
    "to": string,                    // target node id
    "on"?: "pass" | "fail" | "review" // required when kind="pass-fail"
  }],
  "refusal"?: string                 // set instead of nodes/edges if unsafe/unclear
}`;

export function buildPipelinePrompt(intent: string, ctx: PipelinePromptCtx): { system: string; user: string } {
  const roleRule =
    ctx.scope === 'company' && ctx.availableRoles.length > 0
      ? `- "role" MUST be one of: ${ctx.availableRoles.join(', ')}.`
      : `- "role" is a short descriptive slug (e.g. "implementer", "reviewer"); it is metadata only.`;

  const system = `You are a workflow architect inside an IDE. The user describes a workflow; you output ONE JSON pipeline graph. Never execute anything — only plan.

Return a single JSON object matching this shape:
${SHAPE}

Rules:
- Output ONLY the JSON object. No markdown, no prose.
- Node ids are unique, lowercase, descriptive slugs.
- Wire stages with edges: linear for sequential steps; pass-fail to branch on a validator's verdict (one edge per "on" value you use).
- A "validate" node MUST use branchMode "pass-fail", MUST have a non-empty "validatorPrompt", and its outgoing edges MUST be pass-fail edges.
- Exactly one node has no incoming edge (the start).
- taskTemplate placeholders: {{initial_input}} = the user's input, {{previous_output}} = the previous stage's output, {{vars.<nodeId>.output}} = a specific earlier stage's output.
${roleRule}
- Keep it minimal: 2–5 nodes unless the intent clearly needs more.
- If the intent is unclear or unsafe, return { "summary": "", "nodes": [], "edges": [], "refusal": "<why>" }.`;

  const user = `Workflow to build:\n${intent}`;
  return { system, user };
}
