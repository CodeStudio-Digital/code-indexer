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
  /** Additional roots that native filesystem tools may inspect but not edit. */
  readableRoots?: string[];
  /** Whether ask_user can persist and activate an exact folder grant live. */
  canRequestExternalRoots?: boolean;
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
  const readable = (p.readableRoots ?? []).map((r) => `\`${r}\``).join(', ');
  const readableLine = readable
    ? `\n- Additional read-only roots: ${readable}. Use absolute paths for these roots.`
    : '';
  const requestLine = p.canRequestExternalRoots
    ? `\n- When the user explicitly asks for an external directory that is not listed, call \`ask_user\` with \`filesystem_access:{path,access}\` and exactly two option values: \`authorize\` and \`deny\`. Prefer \`read\` unless edits are required. Do not ask the user to copy files or create another workspace.`
    : '';
  return `

# Permissions & execution boundary
- Native filesystem tools enforce the authorized roots. ${rootLabel}: ${roots}.${readableLine}
- Paths inside the project remain project-relative. Explicitly listed external roots use absolute paths and do not become project/configuration roots.
- Local shell commands start inside the project root but execute on the host unless a container sandbox is attached. Shell cwd stays project-scoped; use native filesystem tools for external roots.
- External access is granted per exact directory, never by inferring permission from a path in prose.${requestLine}
- Tool approval mode: **${p.approvalMode}**. ${approvalLine(p.approvalMode)}`;
}
