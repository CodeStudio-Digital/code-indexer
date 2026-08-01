use std::fmt::{self, Debug, Formatter};
use std::time::{Duration, Instant};

use agent_protocol::generated::v1 as wire;
use agent_protocol::pulse_channel::{
    RunnerPulseAuthenticationKey, RunnerPulseError, ValidatedRunnerPulse,
};

use tokio::sync::watch;

/// Single-use supervisor authority for the exact runner pulse endpoint.
pub(in crate::management::driver) struct ProtectedRunnerPulseAuthority {
    identity: wire::AttemptIdentity,
    runtime_instance_id: String,
    address: String,
    key: RunnerPulseAuthenticationKey,
}

/// Physical proof and live receiver retained beside launch acceptance.
pub struct ProtectedRunnerPulseReceipt {
    monitor: Option<ProtectedRunnerPulseMonitor>,
    initial: Option<ValidatedRunnerPulse>,
}

/// Bounded view of the latest pulse owned by the permanent supervisor core.
pub(in crate::management::driver) struct ProtectedRunnerPulseMonitor {
    updates: watch::Receiver<RunnerPulseMonitorState>,
    timeout: Duration,
    hard_deadline_at_unix_ms: i64,
}

#[derive(Debug, Clone)]
pub(in crate::management::driver) enum RunnerPulseMonitorState {
    Live(RunnerPulseObservation),
    Failed,
}

#[derive(Debug, Clone)]
pub(in crate::management::driver) struct RunnerPulseObservation {
    monotonic_counter: u64,
    received_at: Instant,
}

impl ProtectedRunnerPulseAuthority {
    pub(super) fn new(
        identity: wire::AttemptIdentity,
        runtime_instance_id: String,
        address: String,
        connection_id: &str,
        token: Vec<u8>,
    ) -> Result<Self, RunnerPulseError> {
        Ok(Self {
            identity,
            runtime_instance_id,
            address,
            key: RunnerPulseAuthenticationKey::new(connection_id, token)?,
        })
    }

    #[cfg(windows)]
    pub(super) fn into_parts(
        self,
    ) -> (
        wire::AttemptIdentity,
        String,
        String,
        RunnerPulseAuthenticationKey,
    ) {
        (
            self.identity,
            self.runtime_instance_id,
            self.address,
            self.key,
        )
    }
}

impl ProtectedRunnerPulseReceipt {
    #[cfg(windows)]
    pub(super) const fn new_windows(
        monitor: ProtectedRunnerPulseMonitor,
        initial: ValidatedRunnerPulse,
    ) -> Self {
        Self {
            monitor: Some(monitor),
            initial: Some(initial),
        }
    }

    #[cfg(test)]
    pub(super) const fn new_for_test() -> Self {
        Self {
            monitor: None,
            initial: None,
        }
    }

    #[must_use]
    pub(in crate::management::driver) const fn initial_counter(&self) -> Option<u64> {
        match self.initial.as_ref() {
            Some(pulse) => Some(pulse.monotonic_counter()),
            None => None,
        }
    }

    pub(in crate::management::driver) fn into_monitor(
        mut self,
    ) -> Option<ProtectedRunnerPulseMonitor> {
        self.monitor.take()
    }
}

impl ProtectedRunnerPulseMonitor {
    pub(super) const fn new_windows(
        updates: watch::Receiver<RunnerPulseMonitorState>,
        timeout: Duration,
        hard_deadline_at_unix_ms: i64,
    ) -> Self {
        Self {
            updates,
            timeout,
            hard_deadline_at_unix_ms,
        }
    }

    pub(in crate::management::driver) fn latest(&mut self) -> RunnerPulseMonitorState {
        self.updates.borrow_and_update().clone()
    }

    #[must_use]
    pub(in crate::management::driver) const fn timeout(&self) -> Duration {
        self.timeout
    }

    #[must_use]
    pub(in crate::management::driver) const fn hard_deadline_at_unix_ms(&self) -> i64 {
        self.hard_deadline_at_unix_ms
    }

    #[cfg(test)]
    pub(in crate::management::driver) fn new_for_test(
        timeout: Duration,
        hard_deadline_at_unix_ms: i64,
        observation: RunnerPulseObservation,
    ) -> (Self, watch::Sender<RunnerPulseMonitorState>) {
        let (updates, monitor) = watch::channel(RunnerPulseMonitorState::Live(observation));
        (
            Self {
                updates: monitor,
                timeout,
                hard_deadline_at_unix_ms,
            },
            updates,
        )
    }
}

impl RunnerPulseObservation {
    pub(super) const fn new(pulse: &ValidatedRunnerPulse, received_at: Instant) -> Self {
        Self {
            monotonic_counter: pulse.monotonic_counter(),
            received_at,
        }
    }

    #[must_use]
    pub(in crate::management::driver) const fn monotonic_counter(&self) -> u64 {
        self.monotonic_counter
    }

    #[must_use]
    pub(in crate::management::driver) const fn received_at(&self) -> Instant {
        self.received_at
    }

    #[cfg(test)]
    pub(in crate::management::driver) const fn new_for_test(
        monotonic_counter: u64,
        received_at: Instant,
    ) -> Self {
        Self {
            monotonic_counter,
            received_at,
        }
    }
}

impl Debug for ProtectedRunnerPulseAuthority {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProtectedRunnerPulseAuthority([REDACTED])")
    }
}

impl Debug for ProtectedRunnerPulseReceipt {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProtectedRunnerPulseReceipt")
            .field("initial_counter", &self.initial_counter())
            .finish_non_exhaustive()
    }
}
