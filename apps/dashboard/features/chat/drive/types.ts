/**
 * Frontend shapes for the Session Drive aggregate
 * (`GET /api/coder/sessions/:id/drive`). Mirrors the backend
 * `FsDriveAggregate` in code-agent's filesystem session repository.
 * Kept local to the chat feature — these are view models, not shared
 * contracts.
 */
export interface DriveMemory {
  id: string;
  kind: string;
  title: string;
  body: string;
  pinned: boolean;
  updated_at: string;
}

export interface DriveInvestigation {
  id: string;
  topic: string;
  summary: string;
  body: string;
  source_label: string | null;
  agent_type: string | null;
  tokens: number;
  created_at: string;
}

export interface DrivePlan {
  id: string;
  plan_text: string;
  status: string;
  created_at: string;
}

export interface DriveTaskItem {
  id: string;
  title: string;
  status?: string;
}

export interface DriveTasks {
  summary: string;
  tasks: DriveTaskItem[];
  execution_mode: string | null;
  approved: boolean;
}

export interface DriveAggregate {
  memory: DriveMemory[];
  investigations: DriveInvestigation[];
  fileMap: { read: string[]; changed: string[] };
  plans: DrivePlan[];
  tasks: DriveTasks | null;
}

export type DriveTab = 'map' | 'memory' | 'investigations' | 'plans';
