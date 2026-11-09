import type { CompactionSummary, CompactionSummaryV2, CompactionSummaryV3 } from './summary-types.js';
import { capCompactionSummaryV3 } from './summary-codec.js';

export function summaryV2ToV3(summary: CompactionSummaryV2): CompactionSummaryV3 {
  return capCompactionSummaryV3({
    version: 3,
    chapter: {
      title: summary.primary_request || 'Conversation progress',
      summary: summary.problem_solving || summary.current_work,
      user_requests: summary.primary_request ? [summary.primary_request] : [],
      decisions: [],
      work_completed: summary.problem_solving ? [summary.problem_solving] : [],
      files: summary.files_and_code,
      open_issues: summary.errors_and_fixes,
      resolved_issues: [],
    },
    resume: {
      objective: summary.primary_request,
      current_focus: summary.current_work,
      constraints: [],
      pending_tasks: summary.pending_tasks,
      next_step: summary.next_step,
    },
  });
}

export function summaryV3ToV2(summary: CompactionSummaryV3): CompactionSummaryV2 {
  return {
    primary_request: summary.resume.objective,
    key_concepts: [],
    files_and_code: summary.chapter.files,
    errors_and_fixes: [
      ...summary.chapter.open_issues.map((issue) => `Open: ${issue}`),
      ...summary.chapter.resolved_issues.map((issue) => `Resolved: ${issue}`),
    ],
    problem_solving: summary.chapter.summary || summary.chapter.work_completed.join('; '),
    // V3 intentionally does not duplicate verbatim human messages in summaries.
    all_user_messages: [],
    pending_tasks: summary.resume.pending_tasks,
    current_work: summary.resume.current_focus,
    next_step: summary.resume.next_step,
  };
}

export function summaryV3ToLegacy(summary: CompactionSummaryV3): CompactionSummary {
  return {
    what_done: summary.chapter.summary || summary.chapter.work_completed.join('; '),
    current_work: summary.resume.current_focus,
    files_touched: summary.chapter.files.map((file) => file.path),
    decisions: summary.chapter.decisions,
    next_steps: summary.resume.pending_tasks.length > 0
      ? summary.resume.pending_tasks
      : (summary.resume.next_step ? [summary.resume.next_step] : []),
    user_preferences: summary.resume.constraints,
  };
}
