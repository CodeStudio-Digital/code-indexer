use std::time::{SystemTime, UNIX_EPOCH};

use crate::binding::DurableHostAttemptBinding;
use crate::endpoint::{HostControlChannel, HostDataChannel, HostEndpointBinding, HostEndpointKind};
use crate::error::HostBridgeError;
use crate::platform;
use crate::request::HostBridgePlan;

#[derive(Debug)]
pub struct AuthenticatedHostAttemptChannels {
    binding: DurableHostAttemptBinding,
    control: HostControlChannel,
    data: HostDataChannel,
}

impl AuthenticatedHostAttemptChannels {
    /// Decodes one bounded request, binds its durable facts, then verifies
    /// Control and Data against the same expected runner PID on their live
    /// operating-system connections.
    ///
    /// # Errors
    ///
    /// Any malformed fact, elapsed deadline, unsupported platform, canonical
    /// address failure, or peer mismatch closes all opened clients.
    pub fn open(encoded: Vec<u8>) -> Result<Self, HostBridgeError> {
        let started_at = now_unix_ms()?;
        let plan = HostBridgePlan::decode(encoded, started_at)?;
        let control_stream = connect(
            &plan.control,
            plan.binding.runner_pid,
            HostEndpointKind::Control,
        )?;
        ensure_live_deadline(started_at, plan.open_deadline_at_unix_ms)?;
        let data_stream = connect(&plan.data, plan.binding.runner_pid, HostEndpointKind::Data)?;
        ensure_live_deadline(started_at, plan.open_deadline_at_unix_ms)?;
        let peer_pid = plan.binding.runner_pid;
        Ok(Self {
            binding: plan.binding,
            control: HostControlChannel {
                binding: endpoint_binding(plan.control, peer_pid),
                stream: control_stream,
            },
            data: HostDataChannel {
                binding: endpoint_binding(plan.data, peer_pid),
                stream: data_stream,
            },
        })
    }

    #[must_use]
    pub const fn binding(&self) -> &DurableHostAttemptBinding {
        &self.binding
    }

    #[must_use]
    pub fn into_channels(self) -> (HostControlChannel, HostDataChannel) {
        (self.control, self.data)
    }
}

#[cfg(windows)]
fn connect(
    plan: &crate::endpoint::EndpointPlan,
    runner_pid: u32,
    kind: HostEndpointKind,
) -> Result<platform::NativeEndpointClient, HostBridgeError> {
    platform::connect(plan, runner_pid).map_err(|source| HostBridgeError::Endpoint { kind, source })
}

#[cfg(not(windows))]
const fn connect(
    _plan: &crate::endpoint::EndpointPlan,
    _runner_pid: u32,
    _kind: HostEndpointKind,
) -> Result<platform::NativeEndpointClient, HostBridgeError> {
    Err(HostBridgeError::UnsupportedPlatform)
}

fn ensure_live_deadline(started_at: i64, deadline: i64) -> Result<(), HostBridgeError> {
    let observed_at = now_unix_ms()?;
    if observed_at < started_at {
        return Err(HostBridgeError::ClockRegressed);
    }
    if observed_at >= deadline {
        return Err(HostBridgeError::DeadlineElapsed);
    }
    Ok(())
}

fn now_unix_ms() -> Result<i64, HostBridgeError> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| HostBridgeError::ClockUnavailable)?;
    i64::try_from(elapsed.as_millis()).map_err(|_| HostBridgeError::ClockUnavailable)
}

fn endpoint_binding(plan: crate::endpoint::EndpointPlan, peer_pid: u32) -> HostEndpointBinding {
    HostEndpointBinding {
        endpoint_id: plan.endpoint_id,
        connection_id: plan.connection_id,
        maximum_frame_bytes: plan.maximum_frame_bytes,
        peer_pid,
    }
}
