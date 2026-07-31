/** Shared types used by the New Company dialog. */

export interface Template {
  id: number;
  name: string;
  description: string;
  roles: Array<{
    role: string;
    provider: string;
    model: string;
    tier: string;
    skills?: string[];
    initialTools?: string[];
    systemPromptOverride?: string;
    projectHints?: string[];
    projectIds?: number[];
  }>;
}

export interface Project {
  id: number;
  name: string;
  root_path: string;
}
