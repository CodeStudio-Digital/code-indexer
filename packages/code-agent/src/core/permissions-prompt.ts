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
 * Renders above the dynamic boundary. The runner recomposes it when the
 * session owner changes permission mode.
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
  /** Whether native tools can address any absolute path available on the host. */
  unrestrictedFilesystem?: boolean;
  /** Effective tool-approval mode. */
  approvalMode: PromptApprovalMode;
}

function approvalLine(mode: PromptApprovalMode): string {
  switch (mode) {
    case 'ask':
      return 'Mutating and shell tools PAUSE for required approval unless a saved grant applies. The runner presents each approval; do not duplicate it with ask_user. Never assume a write happened before its result.';
    case 'auto':
      return 'Ordinary file writes/edits run without prompting; shell/execute and admin actions require approval unless a saved grant applies. Proceed on authorized reversible edits without asking.';
    case 'unrestricted':
    default:
      return 'Standard tool approvals are disabled; scope, Plan/Spec and filesystem restrictions still apply. Ask only for authority or a material user decision that is actually missing.';
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
    ? `\n- Additional read-only roots/files: ${readable}. Use absolute paths for these entries.`
    : '';
  const requestLine = p.canRequestExternalRoots
    ? `\n- When the user explicitly asks for an external directory that is not listed, call \`ask_user\` with \`filesystem_access:{path,access}\` and exactly two option values: \`authorize\` and \`deny\`. Prefer \`read\` unless edits are required. Do not ask the user to copy files or create another workspace.`
    : '';
  const filesystem = p.unrestrictedFilesystem
    ? `- The local filesystem is available to the tools allowed for this session, subject to operating system permissions.
- Use absolute paths with native filesystem tools such as \`list_directory\`, \`read_file\` and \`glob\` for folders outside the project. The project index remains project-scoped.
- Use absolute working directories for external shell commands when shell tools are available. Proceed directly with authorized work on these paths.`
    : `- Native filesystem tools enforce the authorized roots. ${rootLabel}: ${roots}.${readableLine}
- Paths inside the project remain project-relative. Explicitly listed external roots use absolute paths and do not become project/configuration roots.
- Local shell commands start inside the project root but execute on the host unless a container sandbox is attached. Shell cwd stays project-scoped; use native filesystem tools for external roots.
- External access is granted per saved path (an authorized directory or an exact attached-file reference), never by inferring permission from prose.${requestLine}`;
  return `

# Permissions & execution boundary
${filesystem}
- Tool approval mode: **${p.approvalMode}**. ${approvalLine(p.approvalMode)}
- Database writes require their explicit approval or a saved tool grant. ${p.approvalMode === 'unrestricted'
  ? 'Historical unknown outcomes do not revoke unrestricted permission for new work. Continue new authorized edits and commands without another approval. Exact replay of an uncertain operation remains separately guarded.'
  : 'Pending unknown outcomes require recovery approval for new effects until the host records a terminal receipt or an explicit user review.'} Review is not proof of success and does not authorize blindly replaying the original uncertain action. Required recovery decisions are presented by the harness; do not duplicate them with prose permission questions.`;
}
