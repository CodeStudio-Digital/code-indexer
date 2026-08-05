use super::{
    AdmissionClosureReason, CleanupPhase, CleanupSchedule, CleanupStateError, CleanupTrigger,
    SupervisorDriverState, validate_now,
};
use crate::process_table::OwnershipKey;

impl SupervisorDriverState {
    #[must_use]
    pub fn next_cleanup_deadline_unix_ms(&self) -> Option<i64> {
        earliest_deadline(
            self.next_attempt_cleanup_deadline_unix_ms(),
            self.drain_deadline_at_unix_ms,
        )
    }

    fn next_attempt_cleanup_deadline_unix_ms(&self) -> Option<i64> {
        self.cleanup
            .iter()
            .map(|entry| {
                entry
                    .hard_deadline_at_unix_ms
                    .map_or(entry.deadline_at_unix_ms, |hard| {
                        hard.min(entry.deadline_at_unix_ms)
                    })
            })
            .min()
    }

    #[cfg(test)]
    pub(crate) fn test_next_attempt_cleanup_deadline_unix_ms(&self) -> Option<i64> {
        self.next_attempt_cleanup_deadline_unix_ms()
    }

    pub(in crate::management::driver) fn close_for_shutdown(
        &mut self,
        now_unix_ms: i64,
        terminate_at_unix_ms: i64,
        keys: impl IntoIterator<Item = OwnershipKey>,
    ) -> Result<(), CleanupStateError> {
        self.admission_closed
            .get_or_insert(AdmissionClosureReason::Shutdown);
        self.schedule_physical_termination(
            CleanupTrigger::Shutdown,
            now_unix_ms,
            terminate_at_unix_ms,
            None,
            keys,
        )?;
        self.drain_deadline_at_unix_ms = None;
        Ok(())
    }

    pub(in crate::management::driver) fn close_for_drain(
        &mut self,
        now_unix_ms: i64,
        drain_deadline_at_unix_ms: i64,
    ) -> Result<(), CleanupStateError> {
        validate_now(now_unix_ms)?;
        if drain_deadline_at_unix_ms <= now_unix_ms {
            return Err(CleanupStateError::CleanupDeadlineElapsed);
        }
        self.admission_closed
            .get_or_insert(AdmissionClosureReason::Shutdown);
        self.drain_deadline_at_unix_ms = earliest_deadline(
            self.drain_deadline_at_unix_ms,
            Some(drain_deadline_at_unix_ms),
        );
        Ok(())
    }

    pub(in crate::management::driver) fn schedule_physical_termination(
        &mut self,
        trigger: CleanupTrigger,
        now_unix_ms: i64,
        terminate_at_unix_ms: i64,
        hard_deadline_at_unix_ms: Option<i64>,
        keys: impl IntoIterator<Item = OwnershipKey>,
    ) -> Result<(), CleanupStateError> {
        validate_now(now_unix_ms)?;
        if terminate_at_unix_ms < now_unix_ms
            || hard_deadline_at_unix_ms
                .is_some_and(|deadline| deadline <= now_unix_ms || deadline < terminate_at_unix_ms)
        {
            return Err(CleanupStateError::InvalidTime);
        }
        for key in keys {
            if let Some(entry) = self.cleanup.iter_mut().find(|entry| entry.key == key) {
                update_schedule(
                    entry,
                    trigger,
                    terminate_at_unix_ms,
                    hard_deadline_at_unix_ms,
                );
            } else {
                self.cleanup.push(CleanupSchedule {
                    key,
                    trigger,
                    phase: CleanupPhase::Grace,
                    deadline_at_unix_ms: terminate_at_unix_ms,
                    hard_deadline_at_unix_ms,
                });
            }
        }
        Ok(())
    }

    pub(in crate::management::driver) fn install_authority_watchdog(
        &mut self,
        now_unix_ms: i64,
        deadline_at_unix_ms: i64,
        key: OwnershipKey,
    ) -> Result<(), CleanupStateError> {
        self.schedule_physical_termination(
            CleanupTrigger::AuthorityWatchdog,
            now_unix_ms,
            deadline_at_unix_ms,
            None,
            [key],
        )
    }

    pub(in crate::management::driver) fn ensure_cleanup_deadlines(
        &self,
        now_unix_ms: i64,
    ) -> Result<(), CleanupStateError> {
        validate_now(now_unix_ms)?;
        if self
            .drain_deadline_at_unix_ms
            .is_some_and(|deadline| now_unix_ms >= deadline)
            || self.cleanup.iter().any(|entry| {
                entry
                    .hard_deadline_at_unix_ms
                    .is_some_and(|deadline| now_unix_ms >= deadline)
            })
        {
            Err(CleanupStateError::CleanupDeadlineElapsed)
        } else {
            Ok(())
        }
    }

    pub(in crate::management::driver) fn ensure_cleanup_deadline_for(
        &self,
        key: &OwnershipKey,
        now_unix_ms: i64,
    ) -> Result<(), CleanupStateError> {
        validate_now(now_unix_ms)?;
        let entry = self
            .cleanup
            .iter()
            .find(|entry| &entry.key == key)
            .ok_or(CleanupStateError::UnknownOwnership)?;
        if self
            .drain_deadline_at_unix_ms
            .is_some_and(|deadline| now_unix_ms >= deadline)
            || entry
                .hard_deadline_at_unix_ms
                .is_some_and(|deadline| now_unix_ms >= deadline)
        {
            Err(CleanupStateError::CleanupDeadlineElapsed)
        } else {
            Ok(())
        }
    }
}

fn update_schedule(
    entry: &mut CleanupSchedule,
    trigger: CleanupTrigger,
    terminate_at_unix_ms: i64,
    hard_deadline_at_unix_ms: Option<i64>,
) {
    if trigger == CleanupTrigger::Reap && can_advance(entry.phase) {
        entry.deadline_at_unix_ms = entry.deadline_at_unix_ms.min(terminate_at_unix_ms);
    } else if entry.phase == CleanupPhase::Grace
        && trigger == CleanupTrigger::AuthorityWatchdog
        && entry.trigger == CleanupTrigger::AuthorityWatchdog
    {
        entry.deadline_at_unix_ms = terminate_at_unix_ms;
    } else if matches!(
        entry.phase,
        CleanupPhase::Grace | CleanupPhase::TerminationDue
    ) {
        entry.deadline_at_unix_ms = entry.deadline_at_unix_ms.min(terminate_at_unix_ms);
    }
    entry.trigger = merge_trigger(entry.trigger, trigger);
    entry.hard_deadline_at_unix_ms =
        earliest_deadline(entry.hard_deadline_at_unix_ms, hard_deadline_at_unix_ms);
}

fn merge_trigger(current: CleanupTrigger, candidate: CleanupTrigger) -> CleanupTrigger {
    match (current, candidate) {
        (existing, CleanupTrigger::Reap) if !matches!(existing, CleanupTrigger::Reap) => existing,
        (CleanupTrigger::Reap, replacement) => replacement,
        (existing, replacement) => existing.max(replacement),
    }
}

const fn can_advance(phase: CleanupPhase) -> bool {
    matches!(
        phase,
        CleanupPhase::Grace
            | CleanupPhase::TerminationDue
            | CleanupPhase::ProvisionCleanupDue
            | CleanupPhase::ReapDue
    )
}

const fn earliest_deadline(current: Option<i64>, candidate: Option<i64>) -> Option<i64> {
    match (current, candidate) {
        (Some(current), Some(candidate)) => Some(if current < candidate {
            current
        } else {
            candidate
        }),
        (Some(current), None) => Some(current),
        (None, Some(candidate)) => Some(candidate),
        (None, None) => None,
    }
}
