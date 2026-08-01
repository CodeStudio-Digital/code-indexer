use std::io::{Read, Write};
use std::time::Duration;

use agent_platform::containment::ContainmentPort;
use agent_protocol::management_channel::ManagementChannelError;

use super::provision::ProtectedLaunchProvisionPort;
use super::state::{AdmissionClosureReason, CleanupStateError};
use super::{
    CleanupDriveReport, SupervisorDriverError, SupervisorLifecycleCore, SupervisorPhysicalDriver,
};
use crate::management::{OnlineLifecycleShutdown, SupervisorLifecycleClock};
use crate::process_table::{OwnershipError, OwnershipKey};

mod clock;
mod phases;

pub(super) use clock::{FixedLifecycleClock, FlooredLifecycleClock, LifecycleClockSampler};

impl<R, W, P, V> SupervisorPhysicalDriver<R, W, P, V>
where
    R: Read,
    W: Write,
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    /// Advances due termination and reap work using the supervisor-owned clock.
    ///
    /// # Errors
    ///
    /// Returns [`CleanupStateError`] when cleanup state contains invalid time
    /// data or a cleanup deadline cannot be represented.
    pub fn drive_cleanup(
        &mut self,
        reap_timeout: Duration,
    ) -> Result<CleanupDriveReport, CleanupStateError> {
        let management_floor = self.channel.owner_now_unix_ms();
        let clock = FlooredLifecycleClock::new(&self.lifecycle_clock, management_floor);
        self.core
            .drive_cleanup_with_clock(&clock, reap_timeout, usize::MAX)
    }

    /// Advances at most one item in each cleanup phase.
    ///
    /// Reap is always a non-blocking observation. A retained group is retried
    /// by a later owner-clock tick rather than waiting inside this call.
    ///
    /// # Errors
    ///
    /// Returns [`CleanupStateError`] when cleanup state is inconsistent or a
    /// protected bootstrap cleanup exceeds its bounded retry budget.
    pub fn drive_cleanup_tick(&mut self) -> Result<CleanupDriveReport, CleanupStateError> {
        let management_floor = self.channel.owner_now_unix_ms();
        let clock = FlooredLifecycleClock::new(&self.lifecycle_clock, management_floor);
        self.core.drive_cleanup_tick_with_clock(&clock)
    }

    pub(super) fn close_for_channel_failure(
        &mut self,
        error: &ManagementChannelError,
        now_unix_ms: i64,
        immediate_key: Option<OwnershipKey>,
    ) -> Result<(), SupervisorDriverError<P::Error>> {
        let reason = if matches!(error, ManagementChannelError::UnexpectedEof) {
            AdmissionClosureReason::UnexpectedEof
        } else if immediate_key.is_some() {
            AdmissionClosureReason::PostSpawnWriteFailure
        } else {
            AdmissionClosureReason::ChannelPoisoned
        };
        self.core
            .close_for_management_loss(reason, now_unix_ms, immediate_key)
    }

    #[cfg(test)]
    pub(super) fn drive_cleanup_at(
        &mut self,
        now_unix_ms: i64,
        reap_timeout: Duration,
    ) -> Result<CleanupDriveReport, CleanupStateError> {
        self.core.drive_cleanup_with_clock(
            &FixedLifecycleClock::new(now_unix_ms),
            reap_timeout,
            usize::MAX,
        )
    }

    #[cfg(test)]
    pub(super) fn drive_cleanup_tick_at(
        &mut self,
        now_unix_ms: i64,
    ) -> Result<CleanupDriveReport, CleanupStateError> {
        self.core.drive_cleanup_with_clock(
            &FixedLifecycleClock::new(now_unix_ms),
            Duration::ZERO,
            1,
        )
    }
}

impl<P, V> SupervisorLifecycleCore<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    pub(in crate::management) fn close_for_management_loss(
        &mut self,
        reason: AdmissionClosureReason,
        now_unix_ms: i64,
        immediate_key: Option<OwnershipKey>,
    ) -> Result<(), SupervisorDriverError<P::Error>> {
        let grace = self.policy.limits().host_disconnect_grace_ms;
        self.state.close_and_schedule(
            reason,
            now_unix_ms,
            grace,
            false,
            self.ownership.owned_keys(),
        )?;
        if let Some(key) = immediate_key {
            if !self.cleanup_owner_is_live(&key)? {
                return Ok(());
            }
            self.state
                .close_and_schedule(reason, now_unix_ms, 0, true, [key])?;
            let mut report = CleanupDriveReport::default();
            let fixed = FixedLifecycleClock::new(now_unix_ms);
            let mut clock = LifecycleClockSampler::new(&fixed, self.last_observed_at_unix_ms);
            self.drive_termination_phase_with_clock(&mut clock, usize::MAX, &mut report)?;
        }
        Ok(())
    }

    pub(in crate::management) fn close_owned_attempt(
        &mut self,
        _reason: AdmissionClosureReason,
        key: &OwnershipKey,
        now_unix_ms: i64,
    ) -> Result<(), SupervisorDriverError<P::Error>> {
        if !self.cleanup_owner_is_live(key)? {
            return Ok(());
        }
        self.state
            .schedule_attempt_cleanup(now_unix_ms, 0, true, [key.clone()])?;
        let mut report = CleanupDriveReport::default();
        let fixed = FixedLifecycleClock::new(now_unix_ms);
        let mut clock = LifecycleClockSampler::new(&fixed, self.last_observed_at_unix_ms);
        self.drive_termination_phase_with_clock(&mut clock, usize::MAX, &mut report)?;
        Ok(())
    }

    fn cleanup_owner_is_live(
        &self,
        key: &OwnershipKey,
    ) -> Result<bool, SupervisorDriverError<P::Error>> {
        match self.ownership.state(key) {
            Ok(_) => Ok(true),
            Err(OwnershipError::MissingAttempt)
                if self.launch_registry.confirms_physical_reap(key) =>
            {
                Ok(false)
            }
            Err(error) => Err(SupervisorDriverError::Ownership(error)),
        }
    }

    pub(super) fn drive_cleanup_with_clock(
        &mut self,
        clock: &dyn SupervisorLifecycleClock,
        reap_timeout: Duration,
        maximum_per_phase: usize,
    ) -> Result<CleanupDriveReport, CleanupStateError> {
        let mut clock = LifecycleClockSampler::new(clock, self.last_observed_at_unix_ms);
        let result = self.drive_cleanup_sampled(&mut clock, reap_timeout, maximum_per_phase);
        if result.is_ok() {
            self.last_observed_at_unix_ms = clock.last();
        }
        result
    }

    pub(in crate::management) fn drive_cleanup_tick_with_clock(
        &mut self,
        clock: &dyn SupervisorLifecycleClock,
    ) -> Result<CleanupDriveReport, CleanupStateError> {
        self.drive_cleanup_with_clock(clock, Duration::ZERO, 1)
    }

    pub(in crate::management) fn begin_shutdown_with_clock(
        &mut self,
        shutdown: OnlineLifecycleShutdown,
        clock: &dyn SupervisorLifecycleClock,
    ) -> Result<(), CleanupStateError> {
        let mut clock = LifecycleClockSampler::new(clock, self.last_observed_at_unix_ms);
        let now_unix_ms = clock.sample()?;
        let terminate_at_unix_ms = shutdown.terminate_at_unix_ms();
        if terminate_at_unix_ms <= now_unix_ms {
            return Err(CleanupStateError::CleanupDeadlineElapsed);
        }
        self.state.close_for_shutdown(
            now_unix_ms,
            terminate_at_unix_ms,
            self.ownership.owned_keys(),
        )?;
        self.last_observed_at_unix_ms = clock.last();
        Ok(())
    }

    fn drive_cleanup_sampled(
        &mut self,
        clock: &mut LifecycleClockSampler<'_>,
        reap_timeout: Duration,
        maximum_per_phase: usize,
    ) -> Result<CleanupDriveReport, CleanupStateError> {
        let started_at = clock.sample()?;
        for key in self.pulse_registry.take_expired(started_at)? {
            if self.ownership.state(&key).is_ok() {
                self.state
                    .schedule_attempt_cleanup(started_at, 0, true, [key])?;
            }
        }
        self.state.ensure_cleanup_deadlines(started_at)?;
        let mut report = CleanupDriveReport::default();
        self.drive_termination_phase_with_clock(clock, maximum_per_phase, &mut report)
            .map_err(|error| match error {
                SupervisorDriverError::CleanupState(state) => state,
                _ => CleanupStateError::InvalidTransition,
            })?;
        self.drive_provision_cleanup_phase_with_clock(clock, maximum_per_phase, &mut report)?;
        self.drive_reap_phase_with_clock(clock, reap_timeout, maximum_per_phase, &mut report)?;
        let finished_at = clock.sample()?;
        self.state.ensure_cleanup_deadlines(finished_at)?;
        report.retained_for_reap = self.state.pending_cleanup_count();
        Ok(report)
    }
}
