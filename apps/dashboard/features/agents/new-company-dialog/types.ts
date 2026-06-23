/** Shared types used by the New Company dialog. */

export interface Template {
  id: number;
  name: string;
  description: string;
  roles: Array<{ role: string; provider: string; model: string; tier: string; skills?: string[] }>;
}

export interface Project {
  id: number;
  name: string;
  root_path: string;
}
