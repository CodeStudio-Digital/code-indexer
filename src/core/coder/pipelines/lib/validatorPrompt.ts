/**
 * Validator system prompt template. The validator subagent receives this
 * prompt + a single user message containing the upstream stage's final
 * output. Its allowlist is `{ submit_verdict }` — no read tools, no MCP,
 * nothing. Pure inference from the input text.
 *
 * The chat executor parameterises:
 *   - `criteria`         — the pipeline-author's prompt (`node.validatorPrompt`)
 *   - `previousOutput`   — full text of the upstream stage's `output_text`
 *
 * If the validator returns without ever calling `submit_verdict`, the
 * executor's regex fallback (`\b(PASS|FAIL|REVIEW)\b`) parses the final
 * assistant message. When even that fails, the node row is marked failed
 * and the pipeline routes to the `fail` edge.
 */

export interface ValidatorPromptArgs {
  criteria: string;
  previousOutput: string;
  /**
   * Names of read-only auxiliary tools the validator is allowed to call
   * before submitting its verdict (configured per-node via
   * `validatorTools`). Empty → validator runs pure-inference on the
   * upstream output.
   */
  extraToolNames?: string[];
}

export function buildValidatorSystemPrompt(args: ValidatorPromptArgs): string {
  const extras = args.extraToolNames ?? [];
  const toolsSection = extras.length > 0
    ? `# Auxiliary tools (use sparingly before deciding)
You may call any of: ${extras.map((n) => `\`${n}\``).join(', ')}. Each call costs tokens and the verdict should still come from your own reasoning.

`
    : `# Tools
You have ONE tool: submit_verdict. No others are available.

`;

  return `You are a PIPELINE VALIDATOR. The user has run an upstream stage and needs you to decide whether its output meets the bar to advance.

# Criteria (configured by the pipeline author)
${args.criteria.trim()}

${toolsSection}# Your task
Read the upstream stage's output below, decide whether it meets the criteria, and call submit_verdict ONCE with one of:
  - "pass"   — output meets the criteria; pipeline advances along the 'pass' branch
  - "fail"   — output does not meet the criteria; pipeline routes along the 'fail' branch (often a retry loop)
  - "review" — uncertain; needs human review; pipeline routes along the 'review' branch

# Rules
1. Call submit_verdict EXACTLY ONCE. Do not call it more than once.
2. ${extras.length > 0
      ? 'You may call the auxiliary tools above as many times as needed before submit_verdict, but submit_verdict ends the run.'
      : 'submit_verdict is the only tool you have.'}
3. Do not write a final assistant summary. After submit_verdict accepts your call, simply stop.
4. Be specific in the \`reason\` field — name the criterion that passed or failed.
5. When in doubt between fail and review: prefer "review" if the output is plausibly correct but the criterion is ambiguous.
`;
}

export function buildValidatorUserMessage(args: ValidatorPromptArgs): string {
  return `Upstream stage output:

${args.previousOutput.trim() || '(empty)'}`;
}
