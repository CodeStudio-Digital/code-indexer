//! Windows runner endpoint materialization after the protected handoff decode.

use std::fmt::{self, Debug, Formatter};

use agent_platform::ipc::{EndpointBufferCapacity, ProtectedEndpointError};
use agent_platform::windows::ipc::WindowsProtectedEndpoint;
use agent_protocol::generated::v1 as wire;
use agent_protocol::runner_bootstrap::{
    RUNNER_ENDPOINTS_READY_MAX_BYTES, ShapeValidatedRunnerLaunchHandoff,
};
use prost::Message;

mod control_service;
mod control_transition;
mod error;
mod physical;

pub use control_transition::{
    PendingRunnerControlLaunch, PreparedRunnerControlLaunch, RunnerControlTransitionError,
};
pub use error::RunnerMaterializationError;
pub use physical::{RunnerPhysicalBootstrapError, materialize_inherited_windows_bootstrap};

const CONTROL_INDEX: usize = 0;
const DATA_INDEX: usize = 1;
const PULSE_INDEX: usize = 2;

/// Three bound listeners plus a Ready frame that has not been committed.
pub struct PreparedMaterializedRunnerBootstrap {
    handoff: ShapeValidatedRunnerLaunchHandoff,
    control: WindowsProtectedEndpoint,
    data: WindowsProtectedEndpoint,
    runner_pulse: WindowsProtectedEndpoint,
    ready: Vec<u8>,
}

/// Post-Ready owner of the handoff authority and all three Windows listeners.
pub struct MaterializedRunnerBootstrap {
    handoff: ShapeValidatedRunnerLaunchHandoff,
    control: WindowsProtectedEndpoint,
    data: WindowsProtectedEndpoint,
    runner_pulse: WindowsProtectedEndpoint,
}

impl Debug for PreparedMaterializedRunnerBootstrap {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PreparedMaterializedRunnerBootstrap")
            .field("handoff", &"[SHAPE-VALIDATED; SECRETS REDACTED]")
            .field("listeners", &3)
            .field("ready_bytes", &self.ready.len())
            .finish_non_exhaustive()
    }
}

impl Debug for MaterializedRunnerBootstrap {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MaterializedRunnerBootstrap")
            .field("handoff", &"[RETAINED; SECRETS REDACTED]")
            .field("listeners", &3)
            .finish_non_exhaustive()
    }
}

/// Validates physical Windows facts and binds the canonical endpoint set.
///
/// The returned owner cannot expose or acknowledge Ready before a successful
/// write-and-flush callback.
///
/// # Errors
///
/// Rejects an invalid observation time, another runner PID, an expired launch,
/// a non-Windows provisioning mode, a divergent endpoint, or any bind failure.
pub(crate) fn prepare_materialized_windows_bootstrap(
    handoff: ShapeValidatedRunnerLaunchHandoff,
    observed_at_unix_ms: i64,
) -> Result<PreparedMaterializedRunnerBootstrap, RunnerMaterializationError> {
    validate_physical_facts(&handoff, observed_at_unix_ms)?;
    let control = bind_endpoint(&handoff, CONTROL_INDEX, wire::AttemptEndpointKind::Control)?;
    let data = bind_endpoint(&handoff, DATA_INDEX, wire::AttemptEndpointKind::Data)?;
    let runner_pulse = bind_endpoint(
        &handoff,
        PULSE_INDEX,
        wire::AttemptEndpointKind::RunnerPulse,
    )?;
    let ready = prepare_ready(&handoff)?;
    Ok(PreparedMaterializedRunnerBootstrap {
        handoff,
        control,
        data,
        runner_pulse,
        ready,
    })
}

impl PreparedMaterializedRunnerBootstrap {
    /// Commits the sole Ready frame and advances ownership only after success.
    ///
    /// `write_and_flush` must synchronously write the complete bounded frame
    /// and flush its transport. An error drops all three listeners and the
    /// retained handoff authority without producing a materialized owner.
    ///
    /// # Errors
    ///
    /// Returns the callback error without offering retry authority.
    pub(crate) fn commit_ready_with<E>(
        self,
        write_and_flush: impl FnOnce(&[u8]) -> Result<(), E>,
    ) -> Result<MaterializedRunnerBootstrap, E> {
        write_and_flush(&self.ready)?;
        Ok(MaterializedRunnerBootstrap {
            handoff: self.handoff,
            control: self.control,
            data: self.data,
            runner_pulse: self.runner_pulse,
        })
    }
}

fn validate_physical_facts(
    handoff: &ShapeValidatedRunnerLaunchHandoff,
    observed_at_unix_ms: i64,
) -> Result<(), RunnerMaterializationError> {
    if observed_at_unix_ms <= 0 {
        return Err(RunnerMaterializationError::InvalidObservedAt(
            observed_at_unix_ms,
        ));
    }
    let metadata = handoff.metadata();
    let actual_process_id = std::process::id();
    if metadata.runner_process_id != actual_process_id {
        return Err(RunnerMaterializationError::RunnerProcessMismatch {
            expected: metadata.runner_process_id,
            actual: actual_process_id,
        });
    }
    if observed_at_unix_ms >= metadata.hard_deadline_at_unix_ms {
        return Err(RunnerMaterializationError::DeadlineExpired {
            deadline_at: metadata.hard_deadline_at_unix_ms,
            observed_at: observed_at_unix_ms,
        });
    }
    if metadata.endpoints.iter().any(|endpoint| {
        endpoint.provisioning != wire::RunnerEndpointProvisioning::WindowsCreateNamedPipe as i32
    }) {
        return Err(RunnerMaterializationError::WrongProvisioning);
    }
    Ok(())
}

fn bind_endpoint(
    handoff: &ShapeValidatedRunnerLaunchHandoff,
    index: usize,
    expected_kind: wire::AttemptEndpointKind,
) -> Result<WindowsProtectedEndpoint, RunnerMaterializationError> {
    let endpoint = handoff
        .metadata()
        .endpoints
        .get(index)
        .filter(|endpoint| endpoint.kind == expected_kind as i32)
        .ok_or(RunnerMaterializationError::EndpointMapMismatch)?;
    let capacity = u32::try_from(endpoint.max_frame_bytes)
        .map_err(|_| ProtectedEndpointError::InvalidBufferCapacity)
        .and_then(EndpointBufferCapacity::new)
        .map_err(|source| RunnerMaterializationError::EndpointBind {
            kind: expected_kind,
            source,
        })?;
    WindowsProtectedEndpoint::bind_expected_address(&endpoint.address, capacity).map_err(|source| {
        RunnerMaterializationError::EndpointBind {
            kind: expected_kind,
            source,
        }
    })
}

fn prepare_ready(
    handoff: &ShapeValidatedRunnerLaunchHandoff,
) -> Result<Vec<u8>, RunnerMaterializationError> {
    let metadata = handoff.metadata();
    let ready = wire::RunnerEndpointsReady {
        schema_version: metadata.schema_version,
        identity: metadata.identity.clone(),
        runtime_instance_id: metadata.runtime_instance_id.clone(),
        runner_process_id: metadata.runner_process_id,
        acknowledged_handoff_sha256: handoff.original_frame_sha256().to_vec(),
        endpoints: metadata
            .endpoints
            .iter()
            .map(|endpoint| wire::RunnerReadyEndpoint {
                kind: endpoint.kind,
                endpoint_id: endpoint.endpoint_id.clone(),
                address: endpoint.address.clone(),
                connection_id: endpoint.connection_id.clone(),
            })
            .collect(),
    };
    let encoded = ready.encode_to_vec();
    let length = encoded.len();
    if length == 0 || length > RUNNER_ENDPOINTS_READY_MAX_BYTES {
        return Err(RunnerMaterializationError::ReadyFrameSize {
            length,
            maximum: RUNNER_ENDPOINTS_READY_MAX_BYTES,
        });
    }
    Ok(encoded)
}

#[cfg(test)]
mod tests;
