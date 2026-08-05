use crate::process_table::OwnershipKey;

mod scheduling;
mod selection;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionClosureReason {
    Shutdown,
    UnexpectedEof,
    ChannelPoisoned,
    PostSpawnWriteFailure,
    OwnedSpawnFailure,
    ContainmentMismatch,
    AuthorityExpired,
    BootstrapCleanupStalled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupPhase {
    Grace,
    TerminationDue,
    Terminating,
    ProvisionCleanupDue,
    ProvisionCleaning,
    ReapDue,
    Reaping,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum CleanupTrigger {
    AuthorityWatchdog,
    ChannelFailure,
    Shutdown,
    Cancel,
    Fence,
    Reap,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupStateError {
    InvalidTime,
    ClockRegressed,
    DeadlineOverflow,
    CleanupDeadlineElapsed,
    UnknownOwnership,
    InvalidTransition,
    BootstrapCleanupStalled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CleanupSchedule {
    key: OwnershipKey,
    trigger: CleanupTrigger,
    phase: CleanupPhase,
    deadline_at_unix_ms: i64,
    hard_deadline_at_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SupervisorDriverState {
    admission_closed: Option<AdmissionClosureReason>,
    drain_deadline_at_unix_ms: Option<i64>,
    cleanup: Vec<CleanupSchedule>,
}

impl SupervisorDriverState {
    #[must_use]
    pub const fn is_accepting_launches(&self) -> bool {
        self.admission_closed.is_none()
    }

    #[must_use]
    pub const fn closure_reason(&self) -> Option<AdmissionClosureReason> {
        self.admission_closed
    }

    #[must_use]
    pub const fn pending_cleanup_count(&self) -> usize {
        self.cleanup.len()
    }

    pub(super) fn close_and_schedule(
        &mut self,
        reason: AdmissionClosureReason,
        now_unix_ms: i64,
        grace_ms: u64,
        immediate: bool,
        keys: impl IntoIterator<Item = OwnershipKey>,
    ) -> Result<(), CleanupStateError> {
        self.admission_closed.get_or_insert(reason);
        self.schedule_attempt_cleanup(now_unix_ms, grace_ms, immediate, keys)
    }

    pub(super) fn schedule_attempt_cleanup(
        &mut self,
        now_unix_ms: i64,
        grace_ms: u64,
        immediate: bool,
        keys: impl IntoIterator<Item = OwnershipKey>,
    ) -> Result<(), CleanupStateError> {
        validate_now(now_unix_ms)?;
        let grace_ms = if immediate { 0 } else { grace_ms };
        let grace_ms = i64::try_from(grace_ms).map_err(|_| CleanupStateError::DeadlineOverflow)?;
        let deadline = now_unix_ms
            .checked_add(grace_ms)
            .ok_or(CleanupStateError::DeadlineOverflow)?;
        self.schedule_physical_termination(
            CleanupTrigger::ChannelFailure,
            now_unix_ms,
            deadline,
            None,
            keys,
        )
    }

    pub(super) fn schedule_termination_retry(
        &mut self,
        key: &OwnershipKey,
        deadline_at_unix_ms: i64,
    ) -> Result<(), CleanupStateError> {
        validate_now(deadline_at_unix_ms)?;
        let entry = self
            .cleanup
            .iter_mut()
            .find(|entry| &entry.key == key && entry.phase == CleanupPhase::Terminating)
            .ok_or(CleanupStateError::InvalidTransition)?;
        entry.phase = CleanupPhase::TerminationDue;
        entry.deadline_at_unix_ms = deadline_at_unix_ms;
        Ok(())
    }

    pub(super) fn schedule_reap(
        &mut self,
        key: &OwnershipKey,
        deadline_at_unix_ms: i64,
    ) -> Result<(), CleanupStateError> {
        validate_now(deadline_at_unix_ms)?;
        let entry = self
            .cleanup
            .iter_mut()
            .find(|entry| &entry.key == key)
            .ok_or(CleanupStateError::UnknownOwnership)?;
        if !matches!(
            entry.phase,
            CleanupPhase::Terminating | CleanupPhase::ProvisionCleaning | CleanupPhase::Reaping
        ) {
            return Err(CleanupStateError::InvalidTransition);
        }
        entry.phase = CleanupPhase::ReapDue;
        entry.deadline_at_unix_ms = deadline_at_unix_ms;
        Ok(())
    }

    pub(super) fn schedule_reap_retry(
        &mut self,
        key: &OwnershipKey,
        deadline_at_unix_ms: i64,
    ) -> Result<(), CleanupStateError> {
        validate_now(deadline_at_unix_ms)?;
        let entry = self
            .cleanup
            .iter_mut()
            .find(|entry| &entry.key == key && entry.phase == CleanupPhase::Reaping)
            .ok_or(CleanupStateError::InvalidTransition)?;
        entry.phase = CleanupPhase::ReapDue;
        entry.deadline_at_unix_ms = deadline_at_unix_ms;
        Ok(())
    }

    pub(super) fn schedule_provision_cleanup(
        &mut self,
        key: &OwnershipKey,
        deadline_at_unix_ms: i64,
    ) -> Result<(), CleanupStateError> {
        validate_now(deadline_at_unix_ms)?;
        let entry = self
            .cleanup
            .iter_mut()
            .find(|entry| &entry.key == key)
            .ok_or(CleanupStateError::UnknownOwnership)?;
        if !matches!(
            entry.phase,
            CleanupPhase::Terminating | CleanupPhase::ProvisionCleaning | CleanupPhase::Reaping
        ) {
            return Err(CleanupStateError::InvalidTransition);
        }
        entry.phase = CleanupPhase::ProvisionCleanupDue;
        entry.deadline_at_unix_ms = deadline_at_unix_ms;
        Ok(())
    }

    pub(super) fn complete_reap(&mut self, key: &OwnershipKey) -> Result<(), CleanupStateError> {
        let index = self
            .cleanup
            .iter()
            .position(|entry| &entry.key == key && entry.phase == CleanupPhase::Reaping)
            .ok_or(CleanupStateError::InvalidTransition)?;
        self.cleanup.remove(index);
        Ok(())
    }

    pub(super) fn cleanup_trigger(
        &self,
        key: &OwnershipKey,
    ) -> Result<CleanupTrigger, CleanupStateError> {
        self.cleanup
            .iter()
            .find(|entry| &entry.key == key)
            .map(|entry| entry.trigger)
            .ok_or(CleanupStateError::UnknownOwnership)
    }
}

pub(super) const fn validate_now(now_unix_ms: i64) -> Result<(), CleanupStateError> {
    if now_unix_ms <= 0 {
        Err(CleanupStateError::InvalidTime)
    } else {
        Ok(())
    }
}
