/**
 * Render-contract types for the doc shell — a local mirror of the server-side
 * DocModel (packages/services/.../docmodel/types.ts). Kept here so the dashboard
 * renderer stays decoupled from backend packages; the shape is delivered as JSON
 * by GET …/collections/:cid/docmodel. The SAME shell renders the published site.
 */
export interface DocBranding {
  name?: string;
  logoDataUri?: string;
  accent?: string;
  faviconDataUri?: string;
  links?: { label: string; url: string }[];
}
export interface DocGuide { slug: string; title: string; body: string }
export interface DocFolder { name: string; description: string }
export interface DocParam { in: string; name: string; description: string }
export interface DocSample { target: string; language: string; code: string }
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
  description: string;
  paramDocs: DocParam[];
  examples: DocExample[];
  samples: DocSample[];
}
export interface DocModel {
  schemaVersion: 1;
  meta: { title: string; description: string; updatedAt: string };
  branding: DocBranding;
  overview: string;
  guides: DocGuide[];
  folders: DocFolder[];
  endpoints: DocEndpoint[];
  openapi: unknown;
}
