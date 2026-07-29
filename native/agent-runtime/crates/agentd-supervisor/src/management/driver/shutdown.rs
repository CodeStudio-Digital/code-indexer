use agent_platform::containment::ContainmentPort;
use agent_protocol::generated::v1 as wire;
use agent_protocol::management_channel::ValidatedManagementPayload;

use super::{
    CleanupStateError, ProtectedLaunchProvisionPort, SupervisorDriverError, SupervisorLifecycleCore,
};
use crate::management::{OnlineLifecycleShutdown, SupervisorLifecycleClock};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShutdownMode {
    Drain,
    TerminateAfterGrace,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ShutdownCommand {
    mode: ShutdownMode,
    deadline_at_unix_ms: i64,
    idempotency_key: String,
    payload_digest: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ShutdownRecord {
    idempotency_key: String,
    payload_digest: [u8; 32],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShutdownClassification {
    Fresh,
    Replay,
    Escalation,
    Subsumed,
}

#[derive(Debug, Default)]
pub(super) struct ShutdownRegistry {
    drain: Option<ShutdownRecord>,
    terminate: Option<ShutdownRecord>,
}

impl<P, V> SupervisorLifecycleCore<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    pub(in crate::management) fn schedule_shutdown(
        &mut self,
        payload: &ValidatedManagementPayload,
        payload_digest: [u8; 32],
        clock: &dyn SupervisorLifecycleClock,
    ) -> Result<(), SupervisorDriverError<P::Error>> {
        let command = ShutdownCommand::from_validated(payload, payload_digest)
            .ok_or(SupervisorDriverError::ShutdownConflict)?;
        let classification = self
            .shutdown_registry
            .classify(&command)
            .ok_or(SupervisorDriverError::ShutdownConflict)?;
        match classification {
            ShutdownClassification::Fresh | ShutdownClassification::Escalation => {
                self.apply_shutdown(&command, clock)?;
            }
            ShutdownClassification::Replay | ShutdownClassification::Subsumed => {}
        }
        self.shutdown_registry.commit(&command, classification);
        Ok(())
    }

    fn apply_shutdown(
        &mut self,
        command: &ShutdownCommand,
        clock: &dyn SupervisorLifecycleClock,
    ) -> Result<(), SupervisorDriverError<P::Error>> {
        match command.mode {
            ShutdownMode::Drain => self.begin_drain_with_clock(command.deadline_at_unix_ms, clock),
            ShutdownMode::TerminateAfterGrace => {
                let shutdown = OnlineLifecycleShutdown::new(command.deadline_at_unix_ms)
                    .map_err(|_| CleanupStateError::InvalidTime)?;
                self.begin_shutdown_with_clock(shutdown, clock)
            }
        }
        .map_err(SupervisorDriverError::CleanupState)
    }

    fn begin_drain_with_clock(
        &mut self,
        deadline_at_unix_ms: i64,
        clock: &dyn SupervisorLifecycleClock,
    ) -> Result<(), CleanupStateError> {
        let mut clock =
            super::cleanup::LifecycleClockSampler::new(clock, self.last_observed_at_unix_ms);
        let now_unix_ms = clock.sample()?;
        self.state
            .close_for_drain(now_unix_ms, deadline_at_unix_ms)?;
        self.last_observed_at_unix_ms = clock.last();
        Ok(())
    }
}

impl ShutdownCommand {
    fn from_validated(
        payload: &ValidatedManagementPayload,
        payload_digest: [u8; 32],
    ) -> Option<Self> {
        let command = payload.shutdown_supervisor()?;
        let mode = match wire::SupervisorShutdownMode::try_from(command.mode).ok()? {
            wire::SupervisorShutdownMode::Drain => ShutdownMode::Drain,
            wire::SupervisorShutdownMode::TerminateAfterGrace => ShutdownMode::TerminateAfterGrace,
            wire::SupervisorShutdownMode::Unspecified => return None,
        };
        Some(Self {
            mode,
            deadline_at_unix_ms: command.shutdown_deadline_at_unix_ms,
            idempotency_key: command.idempotency_key.clone(),
            payload_digest,
        })
    }

    fn record(&self) -> ShutdownRecord {
        ShutdownRecord {
            idempotency_key: self.idempotency_key.clone(),
            payload_digest: self.payload_digest,
        }
    }
}

impl ShutdownRegistry {
    fn classify(&self, command: &ShutdownCommand) -> Option<ShutdownClassification> {
        if let Some(existing) = self.record_with_key(&command.idempotency_key) {
            return (existing.payload_digest == command.payload_digest)
                .then_some(ShutdownClassification::Replay);
        }
        if self.record_for(command.mode).is_some() {
            return None;
        }
        Some(
            match (command.mode, self.drain.is_some(), self.terminate.is_some()) {
                (ShutdownMode::TerminateAfterGrace, true, false) => {
                    ShutdownClassification::Escalation
                }
                (ShutdownMode::Drain, false, true) => ShutdownClassification::Subsumed,
                _ => ShutdownClassification::Fresh,
            },
        )
    }

    fn commit(&mut self, command: &ShutdownCommand, classification: ShutdownClassification) {
        if classification == ShutdownClassification::Replay {
            return;
        }
        let slot = match command.mode {
            ShutdownMode::Drain => &mut self.drain,
            ShutdownMode::TerminateAfterGrace => &mut self.terminate,
        };
        debug_assert!(
            slot.is_none(),
            "classification reserves one bounded mode slot"
        );
        *slot = Some(command.record());
    }

    const fn record_for(&self, mode: ShutdownMode) -> Option<&ShutdownRecord> {
        match mode {
            ShutdownMode::Drain => self.drain.as_ref(),
            ShutdownMode::TerminateAfterGrace => self.terminate.as_ref(),
        }
    }

    fn record_with_key(&self, key: &str) -> Option<&ShutdownRecord> {
        self.drain
            .iter()
            .chain(self.terminate.iter())
            .find(|record| record.idempotency_key == key)
    }
}
