use crate::process_table::OwnershipKey;

use super::{CleanupPhase, CleanupStateError, SupervisorDriverState, validate_now};

impl SupervisorDriverState {
    pub(in crate::management::driver) fn take_due_terminations(
        &mut self,
        now_unix_ms: i64,
        maximum: usize,
    ) -> Result<Vec<OwnershipKey>, CleanupStateError> {
        self.take_due(
            now_unix_ms,
            maximum,
            |phase| matches!(phase, CleanupPhase::Grace | CleanupPhase::TerminationDue),
            CleanupPhase::Terminating,
        )
    }

    pub(in crate::management::driver) fn take_due_provision_cleanups(
        &mut self,
        now_unix_ms: i64,
        maximum: usize,
    ) -> Result<Vec<OwnershipKey>, CleanupStateError> {
        self.take_due(
            now_unix_ms,
            maximum,
            |phase| phase == CleanupPhase::ProvisionCleanupDue,
            CleanupPhase::ProvisionCleaning,
        )
    }

    pub(in crate::management::driver) fn take_due_reaps(
        &mut self,
        now_unix_ms: i64,
        maximum: usize,
    ) -> Result<Vec<OwnershipKey>, CleanupStateError> {
        self.take_due(
            now_unix_ms,
            maximum,
            |phase| phase == CleanupPhase::ReapDue,
            CleanupPhase::Reaping,
        )
    }

    fn take_due(
        &mut self,
        now_unix_ms: i64,
        maximum: usize,
        matches_phase: impl Fn(CleanupPhase) -> bool,
        selected_phase: CleanupPhase,
    ) -> Result<Vec<OwnershipKey>, CleanupStateError> {
        validate_now(now_unix_ms)?;
        let mut due = Vec::new();
        while due.len() < maximum {
            let Some(index) = self.cleanup.iter().position(|entry| {
                matches_phase(entry.phase) && now_unix_ms >= entry.deadline_at_unix_ms
            }) else {
                break;
            };
            let mut entry = self.cleanup.remove(index);
            entry.phase = selected_phase;
            due.push(entry.key.clone());
            self.cleanup.push(entry);
        }
        Ok(due)
    }
}
