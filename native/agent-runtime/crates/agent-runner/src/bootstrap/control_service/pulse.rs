use std::time::Duration;

use agent_platform::ipc::{EndpointCancellation, ExpectedLocalPeer, ProtectedEndpointError};
use agent_platform::windows::ipc::WindowsProtectedEndpoint;
use agent_protocol::generated::v1 as wire;
use agent_protocol::pulse_channel::{
    RunnerPulseAuthenticationKey, RunnerPulseIdentity, RunnerPulseSender,
};
use agent_protocol::runner_bootstrap::ShapeValidatedRunnerLaunchHandoff;
use tokio::time::Instant;

use super::RunnerControlServiceError;

mod pump;

pub(super) use pump::RunnerPulsePump;

pub(super) struct PendingRunnerPulse {
    endpoint: WindowsProtectedEndpoint,
    expected_supervisor: ExpectedLocalPeer,
    identity: RunnerPulseIdentity,
    key: RunnerPulseAuthenticationKey,
    hard_deadline: Instant,
    interval: Duration,
}

impl PendingRunnerPulse {
    pub(super) fn from_handoff(
        endpoint: WindowsProtectedEndpoint,
        handoff: &mut ShapeValidatedRunnerLaunchHandoff,
        hard_deadline: Instant,
    ) -> Result<Self, RunnerControlServiceError> {
        let metadata = handoff.metadata();
        let interval = Duration::from_millis(metadata.runner_pulse_interval_ms);
        if interval.is_zero() {
            return Err(RunnerControlServiceError::Pulse(
                agent_protocol::pulse_channel::RunnerPulseError::InvalidTimeout,
            ));
        }
        let expected_process_id = metadata
            .expected_supervisor_peer
            .as_ref()
            .map_or(0, |peer| peer.process_id);
        let expected_supervisor = ExpectedLocalPeer::new(expected_process_id)
            .map_err(RunnerControlServiceError::InvalidSupervisorPeer)?;
        let identity = metadata
            .identity
            .as_ref()
            .ok_or(RunnerControlServiceError::InvalidSupervisorPeer(
                ProtectedEndpointError::InvalidPeer,
            ))
            .and_then(|identity| {
                RunnerPulseIdentity::from_attempt(identity, metadata.runtime_instance_id.clone())
                    .map_err(RunnerControlServiceError::Pulse)
            })?;
        let key = handoff
            .take_runner_pulse_key()
            .map_err(RunnerControlServiceError::PulseAuthority)?;
        Ok(Self {
            endpoint,
            expected_supervisor,
            identity,
            key,
            hard_deadline,
            interval,
        })
    }

    pub(super) async fn accept_and_probe(
        self,
        cancellation: &mut EndpointCancellation,
    ) -> Result<RunnerPulsePump, RunnerControlServiceError> {
        let stream = self
            .endpoint
            .accept(self.expected_supervisor, self.hard_deadline, cancellation)
            .await
            .map_err(RunnerControlServiceError::PulseAccept)?;
        let mut sender =
            RunnerPulseSender::new(stream, self.identity, self.key, self.hard_deadline)
                .map_err(RunnerControlServiceError::Pulse)?;
        sender
            .send(
                wire::RunnerPulsePhase::Negotiating,
                0,
                initial_resources(),
                Duration::MAX,
            )
            .await
            .map_err(RunnerControlServiceError::Pulse)?;
        RunnerPulsePump::start(sender, self.interval)
    }
}

const fn initial_resources() -> wire::ResourceSample {
    wire::ResourceSample {
        resident_memory_bytes: 0,
        peak_resident_memory_bytes: 0,
        cpu_time_ms: 0,
        process_count: 1,
        open_file_count: 0,
        spool_bytes: 0,
    }
}
