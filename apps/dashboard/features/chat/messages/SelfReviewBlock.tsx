import { Check, ShieldCheck } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { Markdown } from './Markdown.js';

/**
 * Rich render for the `self_review` / `review_subordinate_work` tool results —
 * replaces the raw text dump. Both produce `formatFindingsForAgent` output
 * (snapshot-review-format.ts):
 *
 *   Review found N item(s) (most severe first):
 *
 *   - [medium] domain/service/access/GateGroupService.php:145
 *     <body>
 *     suggested fix: <fix>
 *   - [high] …
 *
 *   Decide which are worth it. …            ← trailing guidance, stripped here
 *
 * Or, when clean: "Review complete: no issues found in the pending changes."
 */
interface Finding {
  severity: string;
  loc: string;
  body: string;
  fix?: string;
}

const HEADER_RE = /^- \[([^\]]+)\]\s+(.+)$/gm;

function parseReview(text: string): { noIssues: boolean; findings: Finding[] } {
  const hasItems = /^- \[/m.test(text);
  if (!hasItems && /no issues found|no pending changes/i.test(text)) {
    return { noIssues: true, findings: [] };
  }
  // Drop the trailing "Decide which are worth it…" guidance paragraph.
  const main = text.split(/\n\s*Decide which are worth it/)[0];
  const matches = [...main.matchAll(HEADER_RE)];
  const findings: Finding[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? main.length) : main.length;
    const rest = main.slice(start, end);
    const fixAt = rest.search(/^\s*suggested fix:/m);
    let body: string;
    let fix: string | undefined;
    if (fixAt >= 0) {
      body = rest.slice(0, fixAt).trim();
      fix = rest.slice(fixAt).replace(/^\s*suggested fix:\s*/, '').trim();
    } else {
      body = rest.trim();
    }
    findings.push({ severity: m[1].trim().toLowerCase(), loc: m[2].trim(), body, fix });
  }
  return { noIssues: false, findings };
}

function severityClass(sev: string): string {
  if (sev === 'critical' || sev === 'high') {
    return 'text-destructive bg-destructive/10 border-destructive/30';
  }
  if (sev === 'medium') {
    return 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/30';
  }
  return 'text-muted-foreground bg-muted border-border';
}

export function SelfReviewBlock({ text }: { text: string }) {
  const { noIssues, findings } = parseReview(text);

  if (noIssues) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-success">
        <ShieldCheck className="h-3.5 w-3.5" />
        <span>No issues found in the pending changes.</span>
      </div>
    );
  }

  if (findings.length === 0) {
    // Unparseable shape — fall back to the raw text rather than hide it.
    return <div className="text-xs text-foreground/80 whitespace-pre-wrap">{text}</div>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Check className="h-3.5 w-3.5" />
        {findings.length} finding{findings.length !== 1 ? 's' : ''} · most severe first
      </div>
      {findings.map((f, i) => (
        <div key={i} className="rounded-md border bg-card/50 p-2 space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide border',
                severityClass(f.severity),
              )}
            >
              {f.severity}
            </span>
            <span className="font-mono text-[11px] text-foreground/80 break-all">{f.loc}</span>
          </div>
          <div className="text-xs text-foreground/80">
            <Markdown text={f.body} />
          </div>
          {f.fix && (
            <div className="rounded border border-border/70 bg-muted/40 px-2 py-1.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
                Suggested fix
              </div>
              <div className="text-[11px] text-foreground/80">
                <Markdown text={f.fix} />
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
