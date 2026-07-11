import type { AppPipelineStage } from './app-studio-api.js';

export function isStageApprovalBlocked(stage: AppPipelineStage | null | undefined): boolean {
  return !!stage
    && stage.status === 'active'
    && stage.submitted_at != null
    && stage.gate != null
    && !stage.gate.ok;
}

export function stageBlockingIssueCount(stage: AppPipelineStage | null | undefined): number {
  return isStageApprovalBlocked(stage) ? stage!.gate!.issues.length : 0;
}
