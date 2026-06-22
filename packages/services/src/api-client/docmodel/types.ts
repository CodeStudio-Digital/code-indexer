/**
 * DocModel — the serializable documentation bundle for a collection. It is the
 * CONTRACT between authoring and rendering: the doc shell renders ONLY a DocModel
 * (no store, no fetch), so local preview === published output. Built purely by
 * build-doc-model.ts from store rows; safe to ship (examples are redacted before
 * they ever reach a DocModel).
 */

export interface DocBranding {
  name?: string;
  logoDataUri?: string;
  accent?: string;
  faviconDataUri?: string;
  links?: { label: string; url: string }[];
}

export interface DocGuide {
  slug: string;
  title: string;
  body: string; // markdown
}

export interface DocFolder {
  name: string;
  description: string; // markdown
}

export interface DocParam {
  in: string; // 'query' | 'header' | 'path'
  name: string;
  description: string; // markdown
}

export interface DocSample {
  target: string;   // codegen target id (e.g. 'curl-bash')
  language: string; // highlight language
  code: string;
}

export interface DocExample {
  name: string;
  req: { method: string; url: string };
  status: number | null;
  statusText: string | null;
  contentType: string | null;
  headers: Record<string, string>;
  body: string | null;
}

export interface DocEndpoint {
  id: number;
  name: string;
  method: string;
  path: string;
  folder: string | null;
  description: string; // markdown
  paramDocs: DocParam[];
  examples: DocExample[];
  samples: DocSample[];
}

export interface DocModel {
  schemaVersion: 1;
  meta: { title: string; description: string; updatedAt: string };
  branding: DocBranding;
  overview: string; // markdown
  guides: DocGuide[];
  folders: DocFolder[];
  endpoints: DocEndpoint[];
  /** OpenAPI 3.1 doc for the embedded reference (Scalar) pane. */
  openapi: unknown;
}
