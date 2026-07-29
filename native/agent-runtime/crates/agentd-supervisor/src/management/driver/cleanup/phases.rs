use std::time::Duration;

use agent_platform::containment::ContainmentPort;

use super::super::completion_cleanup::CompletionCleanupAttempt;
use super::super::provision::ProtectedLaunchProvisionPort;
use super::super::state::{AdmissionClosureReason, CleanupStateError};
use super::super::{CleanupDriveReport, SupervisorDriverError, SupervisorLifecycleCore};
use super::clock::LifecycleClockSampler;
use crate::process_table::{ContainmentOperationError, ReapAfterCleanupError, SpawnHandoffState};

const TERMINATION_EXIT_CODE: u32 = 0xE000_0001;
const TERMINATION_RETRY_MS: i64 = 100;
const PROVISION_CLEANUP_RETRY_MS: i64 = 100;
const REAP_RETRY_MS: i64 = 100;

impl<P, V> SupervisorLifecycleCore<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    pub(super) fn drive_termination_phase_with_clock(
        &mut self,
        clock: &mut LifecycleClockSampler<'_>,
        maximum: usize,
        report: &mut CleanupDriveReport,
    ) -> Result<(), SupervisorDriverError<P::Error>> {
        for _ in 0..maximum {
            let before = clock.sample()?;
            self.state.ensure_cleanup_deadlines(before)?;
            let Some(key) = self
                .state
                .take_due_terminations(before, 1)?
                .into_iter()
                .next()
            else {
                break;
            };
            report.termination_attempts += 1;
            let effect =
                self.ownership
                    .terminate(self.containment.as_ref(), &key, TERMINATION_EXIT_CODE);
            let after = clock.sample()?;
            self.state.ensure_cleanup_deadline_for(&key, after)?;
            if effect.is_err() {
                report.termination_failures += 1;
                self.state
                    .schedule_termination_retry(&key, retry_at(after, TERMINATION_RETRY_MS)?)?;
            } else if matches!(
                self.ownership
                    .spawn_handoff_state(&key)
                    .map_err(|_| CleanupStateError::InvalidTransition)?,
                Some(SpawnHandoffState::Launching | SpawnHandoffState::BootstrapPending)
            ) {
                self.state
                    .schedule_termination_retry(&key, retry_at(after, TERMINATION_RETRY_MS)?)?;
            } else if self.completion_cleanup.owns(&key) {
                self.state.schedule_provision_cleanup(&key, after)?;
            } else {
                self.state.schedule_reap(&key, after)?;
            }
        }
        Ok(())
    }

    pub(super) fn drive_provision_cleanup_phase_with_clock(
        &mut self,
        clock: &mut LifecycleClockSampler<'_>,
        maximum: usize,
        report: &mut CleanupDriveReport,
    ) -> Result<(), CleanupStateError> {
        for _ in 0..maximum {
            let before = clock.sample()?;
            self.state.ensure_cleanup_deadlines(before)?;
            let Some(key) = self
                .state
                .take_due_provision_cleanups(before, 1)?
                .into_iter()
                .next()
            else {
                break;
            };
            report.provision_cleanup_attempts += 1;
            let effect = self.completion_cleanup.cleanup_one(&key);
            let after = clock.sample()?;
            self.state.ensure_cleanup_deadline_for(&key, after)?;
            match effect {
                CompletionCleanupAttempt::Completed if !self.completion_cleanup.owns(&key) => {
                    self.state.schedule_reap(&key, after)?;
                }
                CompletionCleanupAttempt::Completed | CompletionCleanupAttempt::Retry => {
                    report.provision_cleanup_failures += 1;
                    self.state.schedule_provision_cleanup(
                        &key,
                        retry_at(after, PROVISION_CLEANUP_RETRY_MS)?,
                    )?;
                }
                CompletionCleanupAttempt::Stalled => {
                    report.provision_cleanup_failures += 1;
                    report.provision_cleanup_stalls += 1;
                    self.state.close_and_schedule(
                        AdmissionClosureReason::BootstrapCleanupStalled,
                        after,
                        0,
                        true,
                        self.ownership.owned_keys(),
                    )?;
                    return Err(CleanupStateError::BootstrapCleanupStalled);
                }
                CompletionCleanupAttempt::Absent => {
                    return Err(CleanupStateError::InvalidTransition);
                }
            }
        }
        Ok(())
    }

    pub(super) fn drive_reap_phase_with_clock(
        &mut self,
        clock: &mut LifecycleClockSampler<'_>,
        reap_timeout: Duration,
        maximum: usize,
        report: &mut CleanupDriveReport,
    ) -> Result<(), CleanupStateError> {
        for _ in 0..maximum {
            let before = clock.sample()?;
            self.state.ensure_cleanup_deadlines(before)?;
            let Some(key) = self.state.take_due_reaps(before, 1)?.into_iter().next() else {
                break;
            };
            if self.completion_cleanup.owns(&key) {
                self.state.schedule_provision_cleanup(
                    &key,
                    retry_at(before, PROVISION_CLEANUP_RETRY_MS)?,
                )?;
                continue;
            }
            report.reap_attempts += 1;
            let effect = self.ownership.reap_after_cleanup_gated(
                self.containment.as_ref(),
                &key,
                reap_timeout,
                || {
                    clock.sample().and_then(|after| {
                        self.state
                            .ensure_cleanup_deadline_for(&key, after)
                            .map(|()| after)
                    })
                },
            );
            match effect {
                Ok(_) => {
                    report.reaped += 1;
                    debug_assert!(!self.completion_cleanup.owns(&key));
                    self.launch_registry.mark_physical_reaped(&key);
                    self.state.complete_reap(&key)?;
                }
                Err(ReapAfterCleanupError::PostReapGate(error)) => return Err(error),
                Err(ReapAfterCleanupError::Operation(ContainmentOperationError::Platform(_))) => {
                    let after = clock.sample()?;
                    self.state.ensure_cleanup_deadline_for(&key, after)?;
                    self.state
                        .schedule_reap_retry(&key, retry_at(after, REAP_RETRY_MS)?)?;
                }
                Err(ReapAfterCleanupError::Operation(ContainmentOperationError::Ownership(_))) => {
                    self.state
                        .schedule_reap_retry(&key, retry_at(before, REAP_RETRY_MS)?)?;
                    return Err(CleanupStateError::InvalidTransition);
                }
            }
        }
        Ok(())
    }
}

const fn retry_at(now_unix_ms: i64, delay_ms: i64) -> Result<i64, CleanupStateError> {
    match now_unix_ms.checked_add(delay_ms) {
        Some(next) => Ok(next),
        None => Err(CleanupStateError::DeadlineOverflow),
    }
}
