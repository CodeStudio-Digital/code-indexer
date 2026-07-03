/**
 * Structured IDE context (Codex parity — `.referece/codex/codex-rs/tui/src/ide_context.rs`).
 *
 * Today only the editor Copilot rail feeds the agent any editor state, and only
 * as ad-hoc `<selected-code>` text. This is the structured payload the MAIN
 * agent loop can receive: active file, pinned selections, and open tabs. The
 * transport carries it on the send; `runCoder` renders it into an `<ide_context>`
 * block prepended to that turn's user message (send-time snapshot — not
 * re-injected every turn).
 *
 * Kept as a plain structural type (no dependency on the dashboard store) — the
 * UI passes a matching shape, mirroring how `memoryRetriever` stays decoupled.
 */

export interface IdeSelection {
  /** Project-root-relative path. */
  path: string;
  startLine: number;
  endLine: number;
  /** Selected text (optional — omitted for large/whole-file refs). */
  text?: string;
}

export interface IdeContext {
  /** Currently focused file (project-root-relative). */
  activeFile?: string;
  /** Pinned code selections. */
  selections?: IdeSelection[];
  /** Open editor tabs (project-root-relative paths). */
  openTabs?: string[];
}

const MAX_SELECTION_CHARS = 4000;
const MAX_OPEN_TABS = 100;

/**
 * Render an `<ide_context>` block, or '' when there's nothing to say. Bounded:
 * selection bodies and the open-tabs list are capped so a huge editor state
 * can't blow the turn budget.
 */
export function formatIdeContext(ide?: IdeContext): string {
  if (!ide) return '';
  const lines: string[] = [];

  if (ide.activeFile) lines.push(`active file: \`${ide.activeFile}\``);

  if (ide.openTabs && ide.openTabs.length > 0) {
    const shown = ide.openTabs.slice(0, MAX_OPEN_TABS);
    const extra = ide.openTabs.length - shown.length;
    lines.push(`open tabs: ${shown.map((t) => `\`${t}\``).join(', ')}${extra > 0 ? ` (+${extra} more)` : ''}`);
  }

  for (const sel of ide.selections ?? []) {
    const header = `<selection path="${sel.path}" lines="${sel.startLine}-${sel.endLine}">`;
    if (sel.text) {
      const body = sel.text.length > MAX_SELECTION_CHARS ? `${sel.text.slice(0, MAX_SELECTION_CHARS)}\n[…truncated]` : sel.text;
      lines.push(`${header}\n${body}\n</selection>`);
    } else {
      lines.push(`${header}</selection>`);
    }
  }

  if (lines.length === 0) return '';
  return `<ide_context>\n${lines.join('\n')}\n</ide_context>`;
}
