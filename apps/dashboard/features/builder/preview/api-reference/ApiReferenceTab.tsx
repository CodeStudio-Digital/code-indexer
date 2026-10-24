import React, { useMemo, useState, Suspense } from 'react';
import { Loader2, AlertTriangle, FileWarning, BookOpen } from 'lucide-react';
import type { SandboxSnapshot } from '../../useSandboxStatus.js';
import { useOpenApiSpec } from './useOpenApiSpec.js';

/**
 * `@scalar/api-reference-react` ships a fairly heavy bundle (CSS + the
 * playground client). Lazy-load it so the dashboard's first paint is
 * unaffected for users who never open this tab.
 */
const ScalarApiReference = React.lazy(() =>
  import('@scalar/api-reference-react').then((m) => ({
    default: (m as { ApiReferenceReact: React.ComponentType<{ configuration: unknown }> })
      .ApiReferenceReact,
  })),
);

export interface ServiceOption {
  id: string;
  label: string;
  previewUrl: string;
  status: string;
  runtimePaused?: boolean;
  /**
   * Preview routing strategy chosen for this service (Phase 4). When
   * `port-direct`, the preview iframe loads `http://localhost:${hostPort}`
   * directly instead of going through the proxy at `previewUrl`.
   */
  previewStrategy?: 'proxy-prefix' | 'proxy-root' | 'port-direct';
  /** Required when `previewStrategy === 'port-direct'`. */
  hostPort?: number;
}

interface ApiReferenceTabProps {
  sessionId: string;
  snapshot: SandboxSnapshot | null;
  extraServices: ServiceOption[];
  fileChangeTick?: number;
}

export function ApiReferenceTab({
  sessionId,
  snapshot,
  extraServices,
  fileChangeTick = 0,
}: ApiReferenceTabProps) {
  const services = useMemo<ServiceOption[]>(() => {
    const list: ServiceOption[] = [];
    const primaryUrl = snapshot?.sandbox?.previewUrl;
    if (primaryUrl) {
      list.push({
        id: 'main',
        label: 'Primary',
        previewUrl: primaryUrl,
        status: snapshot?.sandbox?.status ?? 'pending',
        runtimePaused: !!snapshot?.sandbox?.runtimePaused,
      });
    }
    for (const s of extraServices) list.push(s);
    return list;
  }, [snapshot, extraServices]);

  const [selectedId, setSelectedId] = useState<string>(() => services[0]?.id ?? 'main');

  // If the selected service disappears (e.g. it was destroyed), fall
  // back to the first available one so the user is never staring at
  // an empty panel.
  const selected = services.find((s) => s.id === selectedId) ?? services[0] ?? null;
  if (selected && selected.id !== selectedId) {
    // setState during render is fine for a derived selection guard —
    // React will discard the in-progress render and re-run.
    setSelectedId(selected.id);
  }

  const { spec, loading, errorKind, errorMessage, sourcePath } = useOpenApiSpec(
    sessionId,
    selected?.id ?? null,
    fileChangeTick,
  );

  // Build the absolute preview URL for the `servers` override. The
  // backend returns relative URLs (`/preview/<sessionId>/...`) that
  // route through the http-api proxy on the same origin, so we resolve
  // against `window.location.origin` to give Scalar a full URL — this
  // is what shows in the "Server URL" field of "Try it out".
  const absolutePreviewUrl = useMemo(() => {
    if (!selected?.previewUrl) return '';
    try {
      return new URL(selected.previewUrl, window.location.origin).toString();
    } catch {
      return selected.previewUrl;
    }
  }, [selected?.previewUrl]);

  const scalarConfig = useMemo(() => {
    if (!spec) return null;
    return {
      spec: { content: spec as Record<string, unknown> },
      // Override `servers[]` so the playground always points at the
      // live sandbox preview, regardless of what the spec file in git
      // declares. The user-authored servers stay in the spec for
      // documentation purposes (Scalar still lists them in the dropdown
      // when present), but the sandbox URL is the default selection.
      servers: absolutePreviewUrl
        ? [{ url: absolutePreviewUrl, description: 'Sandbox preview' }]
        : undefined,
      hideClientButton: false,
      hideDownloadButton: false,
      darkMode: prefersDark(),
    };
  }, [spec, absolutePreviewUrl]);

  return (
    <div className="flex flex-col h-full bg-card">
      <div className="h-10 flex items-center gap-2 px-3 border-b">
        <BookOpen className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
        <ServiceSwitcher
          services={services}
          selectedId={selected?.id ?? 'main'}
          onChange={setSelectedId}
        />
        <span
          className="font-mono truncate text-xs text-muted-foreground"
          title={sourcePath ?? selected?.previewUrl ?? '—'}
        >
          {sourcePath ?? '—'}
        </span>
        <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
          base: {absolutePreviewUrl || '—'}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {!selected ? (
          <EmptyState
            icon={<FileWarning className="h-5 w-5 text-muted-foreground" />}
            title="No services available"
            hint="Wait for the sandbox to reach the ready state, or provision a microservice."
          />
        ) : loading ? (
          <EmptyState
            icon={<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
            title="Loading OpenAPI spec…"
            hint={`Reading from ${selected.label}`}
          />
        ) : errorKind === 'not_found' ? (
          <EmptyState
            icon={<FileWarning className="h-5 w-5 text-muted-foreground" />}
            title="No OpenAPI document found"
            hint={
              <>
                Add an <code className="text-xs">openapi.yaml</code> /{' '}
                <code className="text-xs">openapi.json</code> to the service workdir, or run the{' '}
                <code className="text-xs">api-collection</code> skill in the agent to generate one.
              </>
            }
          />
        ) : errorKind === 'error' ? (
          <EmptyState
            icon={<AlertTriangle className="h-5 w-5 text-destructive" />}
            title="Failed to load OpenAPI spec"
            hint={errorMessage ?? 'Unknown error'}
          />
        ) : scalarConfig ? (
          <Suspense
            fallback={
              <EmptyState
                icon={<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
                title="Loading API Reference renderer…"
                hint={null}
              />
            }
          >
            <ScalarApiReference configuration={scalarConfig} />
          </Suspense>
        ) : null}
      </div>
    </div>
  );
}

interface ServiceSwitcherProps {
  services: ServiceOption[];
  selectedId: string;
  onChange: (id: string) => void;
}

function ServiceSwitcher({ services, selectedId, onChange }: ServiceSwitcherProps) {
  if (services.length === 0) return null;
  if (services.length === 1) {
    return (
      <span className="text-xs text-muted-foreground truncate" title={services[0].label}>
        {services[0].label}
      </span>
    );
  }
  return (
    <select
      className="text-xs bg-background border rounded px-1 py-0.5 max-w-[180px]"
      value={selectedId}
      onChange={(e) => onChange(e.target.value)}
      title="Switch microservice"
    >
      {services.map((s) => (
        <option key={s.id} value={s.id}>
          {s.label} ({s.runtimePaused ? 'paused' : s.status})
        </option>
      ))}
    </select>
  );
}

function EmptyState({
  icon,
  title,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  hint: React.ReactNode;
}) {
  return (
    <div className="h-full flex items-start gap-3 p-6">
      <div className="flex-shrink-0 mt-0.5">{icon}</div>
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {hint ? <div className="mt-1 text-xs text-muted-foreground leading-relaxed">{hint}</div> : null}
      </div>
    </div>
  );
}

function prefersDark(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  } catch {
    return false;
  }
}
