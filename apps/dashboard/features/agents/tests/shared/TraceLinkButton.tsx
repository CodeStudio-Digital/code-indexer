/**
 * Button that opens a Playwright trace.zip in the official trace
 * viewer (`https://trace.playwright.dev/?trace=<absolute_url>`). The
 * URL passed to the viewer must be reachable by the user's browser,
 * so we resolve it from `window.location.origin` + the workspace
 * path served by `/api/company/sessions/:id/qa/trace`.
 *
 * Pure presentational: takes the session id + workspace-relative
 * path; the parent decides whether to render based on
 * `result.trace_path` presence.
 */
import React from 'react';
import { ExternalLink } from 'lucide-react';

interface Props {
  sessionId: number;
  /** Workspace-relative path stored on the test result row. */
  tracePath: string;
  /**
   * Microservice the trace lives in. Defaults to `'main'` for legacy
   * single-service sessions; multi-service callers pass the run's
   * `service_id` so the viewer fetches from the right workdir.
   */
  serviceId?: string;
}

export function TraceLinkButton({ sessionId, tracePath, serviceId }: Props) {
  const localUrl = buildLocalTraceUrl({ sessionId, tracePath, serviceId });
  const viewerUrl = buildViewerUrl(localUrl);
  return (
    <a
      href={viewerUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
      title={`Open ${tracePath} in Playwright trace viewer`}
    >
      <ExternalLink className="h-3 w-3" />
      View trace
    </a>
  );
}

/** Pure: build the local URL for the trace via the artifact route. */
export function buildLocalTraceUrl(opts: {
  sessionId: number;
  tracePath: string;
  serviceId?: string;
}): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const sp = new URLSearchParams();
  sp.set('service', opts.serviceId ?? 'main');
  sp.set('path', opts.tracePath);
  return `${origin}/api/company/sessions/${opts.sessionId}/qa/artifact?${sp.toString()}`;
}

/** Pure: wrap a fully-qualified local URL into the viewer link. */
export function buildViewerUrl(localUrl: string): string {
  return `https://trace.playwright.dev/?trace=${encodeURIComponent(localUrl)}`;
}
