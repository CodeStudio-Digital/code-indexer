/**
 * LocalProjectDialog — pick a folder on the host and start the project
 * as a plain OS process (no container). Complements the container-backed
 * services in `ServicesSidebar`.
 *
 * UX contract:
 *   - Explicit safety banner: this runs on the host with the server's
 *     privileges, outside the Podman sandbox. The user has to read it.
 *   - Path is validated server-side against known project roots; we
 *     surface the 400 message instead of second-guessing it here.
 *   - `Use AI to port command` is opt-in. Off by default because the
 *     deterministic fallback works for the common stacks.
 */

import { useState, type FormEvent } from 'react';

interface LocalProjectDialogProps {
  sessionId: number;
  onCreated: () => void | Promise<void>;
  onCancel: () => void;
  /** Optional pre-fill (used when Retry opens the dialog on an orphan). */
  initialPath?: string;
  initialUseAi?: boolean;
}

export default function LocalProjectDialog({
  sessionId,
  onCreated,
  onCancel,
  initialPath = '',
  initialUseAi = false,
}: LocalProjectDialogProps) {
  const [path, setPath] = useState(initialPath);
  const [useAi, setUseAi] = useState(initialUseAi);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setDetail(null);
    try {
      const r = await fetch(`/api/company/sessions/${sessionId}/local-project`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: path.trim(), useAi }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
        };
        setError(body.error ?? `HTTP ${r.status}`);
        if (body.code) setDetail(`code: ${body.code}`);
        return;
      }
      const body = (await r.json()) as {
        program: string;
        args: string[];
        rationale: string;
        synth_source: string;
      };
      setDetail(
        `Running: ${body.program} ${body.args.join(' ')} — ${body.rationale}`,
      );
      await onCreated();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-2 border rounded p-2 space-y-2">
      <div className="text-[10px] font-medium">Run local project (host process)</div>

      <div className="rounded border border-amber-500/60 bg-amber-500/10 p-1.5 text-[9px] text-amber-700 dark:text-amber-400">
        <strong>Warning:</strong> this starts the process directly on your
        host as the same user as the MCP server — <em>not</em> inside the
        Podman sandbox. Only point at folders you trust.
      </div>

      <input
        type="text"
        placeholder="Absolute path to project folder"
        className="w-full text-[10px] bg-background border rounded px-1.5 py-1 font-mono"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        required
      />

      <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer select-none">
        <input
          type="checkbox"
          checked={useAi}
          onChange={(e) => setUseAi(e.target.checked)}
          className="h-3 w-3"
        />
        Use AI to port the start command to the chosen port
      </label>

      {detail && !error && (
        <div className="text-[9px] text-muted-foreground truncate" title={detail}>
          {detail}
        </div>
      )}
      {error && (
        <div className="text-[9px] text-red-500">
          {error}
          {detail && <div className="text-muted-foreground">{detail}</div>}
        </div>
      )}

      <div className="flex items-center gap-1 justify-end">
        <button
          type="button"
          className="text-[10px] px-2 py-1 rounded hover:bg-accent"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || !path.trim()}
          className="text-[10px] px-2 py-1 rounded bg-primary text-primary-foreground disabled:opacity-50"
        >
          {submitting ? 'Starting…' : 'Start'}
        </button>
      </div>
    </form>
  );
}
