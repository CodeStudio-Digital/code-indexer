/**
 * Permissions & sandbox prompt fragment.
 *
 * Codex renders the *effective* permission policy into the model prompt
 * (`<permissions instructions>`: sandbox mode, writable roots, approval policy)
 * so the model's behaviour is aligned with what the runtime actually enforces —
 * see `.referece/codex/codex-rs/prompts/src/permissions_instructions.rs`. Our
 * runtime enforces the same things (path-scoped filesystem + a tool-approval
 * gate) but the prompt only carried a generic "sandboxed to the project root"
 * line (base.txt:8) and never told the model the concrete writable root or the
 * active approval MODE. This fragment closes exactly that gap — nothing more,
 * to avoid duplicating base.txt (sandbox) and plan.txt (plan-mode gating).
 *
 * Session-fixed (writable root + the session's tool_permission_mode) →
 * cache-stable, rendered ABOVE the dynamic boundary. Reflects the mode at
 * session start; live mode flips are enforced by the runtime gate regardless.
 */

export type PromptApprovalMode = 'ask' | 'auto' | 'unrestricted';

export interface PromptPermissions {
  /**
   * Absolute path(s) the agent may write to — the project root for local
   * sessions, or the sandbox container workdir in builder/company mode.
   * Usually one entry.
   */
  writableRoots: string[];
  /** Effective tool-approval mode resolved at session start. */
  approvalMode: PromptApprovalMode;
}

function approvalLine(mode: PromptApprovalMode): string {
  switch (mode) {
    case 'ask':
      return 'Mutating and shell tools PAUSE for the user\'s approval before they run. Batch independent actions so one approval covers them, and never assume a write happened until the tool returns a result.';
    case 'auto':
      return 'File writes/edits run without prompting; only higher-risk actions (destructive shell, git history rewrites) may pause. Proceed on reversible edits without asking.';
    case 'unrestricted':
    default:
      return 'No approval prompts — every tool runs immediately. You are fully responsible for destructive actions; reach for `ask_user` only before a genuinely irreversible step (delete/reset/force-push/deploy).';
  }
}

/**
 * Build the `# Permissions & sandbox` block, or '' when no policy is supplied
 * (keeps prompts that don't pass `permissions` byte-identical to before).
 */
export function permissionsSection(p?: PromptPermissions): string {
  if (!p || p.writableRoots.length === 0) return '';
  const roots = p.writableRoots.map((r) => `\`${r}\``).join(', ');
  const rootLabel = p.writableRoots.length === 1 ? 'Writable root' : 'Writable roots';
  return `

# Permissions & sandbox
- Filesystem and shell tools are sandboxed. ${rootLabel}: ${roots}. You cannot read or write outside it.
- Tool approval mode: **${p.approvalMode}**. ${approvalLine(p.approvalMode)}`;
}
