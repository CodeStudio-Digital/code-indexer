use crate::generated::v1 as wire;
use crate::identity::{AttemptId, RuntimeInstanceId};
use crate::wire_identity::MAX_WIRE_IDENTIFIER_BYTES;

use super::RunnerPulseError;

/// Exact identity sealed into every authenticated pulse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerPulseIdentity {
    attempt_id: AttemptId,
    runtime_instance_id: RuntimeInstanceId,
    fencing_epoch: u64,
}

/// Semantically validated pulse accepted by the supervisor receiver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedRunnerPulse {
    phase: wire::RunnerPulsePhase,
    monotonic_counter: u64,
    last_progress_seq: u64,
    resources: wire::ResourceSample,
}

impl RunnerPulseIdentity {
    /// Creates the immutable physical identity for a pulse channel.
    ///
    /// # Errors
    ///
    /// Rejects non-canonical attempt IDs, invalid runtime IDs, or epoch zero.
    pub fn new(
        attempt_id: impl Into<String>,
        runtime_instance_id: impl Into<String>,
        fencing_epoch: u64,
    ) -> Result<Self, RunnerPulseError> {
        let attempt_id =
            AttemptId::new(attempt_id.into()).map_err(|_| RunnerPulseError::InvalidIdentity)?;
        let runtime_instance_id = runtime_instance_id.into();
        if runtime_instance_id.len() > MAX_WIRE_IDENTIFIER_BYTES
            || runtime_instance_id.contains('\0')
            || fencing_epoch == 0
        {
            return Err(RunnerPulseError::InvalidIdentity);
        }
        let runtime_instance_id = RuntimeInstanceId::new(runtime_instance_id)
            .map_err(|_| RunnerPulseError::InvalidIdentity)?;
        Ok(Self {
            attempt_id,
            runtime_instance_id,
            fencing_epoch,
        })
    }

    /// Derives the pulse identity from an already validated attempt identity.
    ///
    /// # Errors
    ///
    /// Rejects missing or invalid attempt identity fields and runtime IDs.
    pub fn from_attempt(
        identity: &wire::AttemptIdentity,
        runtime_instance_id: impl Into<String>,
    ) -> Result<Self, RunnerPulseError> {
        Self::new(
            identity.attempt_id.clone(),
            runtime_instance_id,
            identity.fencing_epoch,
        )
    }

    pub(crate) fn pulse(
        &self,
        phase: wire::RunnerPulsePhase,
        monotonic_counter: u64,
        last_progress_seq: u64,
        resources: wire::ResourceSample,
    ) -> wire::RunnerPulse {
        wire::RunnerPulse {
            attempt_id: self.attempt_id.as_str().to_owned(),
            runtime_instance_id: self.runtime_instance_id.as_str().to_owned(),
            fencing_epoch: self.fencing_epoch,
            phase: phase as i32,
            monotonic_counter,
            last_progress_seq,
            resources: Some(resources),
        }
    }

    pub(crate) fn matches(&self, pulse: &wire::RunnerPulse) -> bool {
        pulse.attempt_id == self.attempt_id.as_str()
            && pulse.runtime_instance_id == self.runtime_instance_id.as_str()
            && pulse.fencing_epoch == self.fencing_epoch
    }
}

impl ValidatedRunnerPulse {
    pub(crate) const fn new(
        phase: wire::RunnerPulsePhase,
        monotonic_counter: u64,
        last_progress_seq: u64,
        resources: wire::ResourceSample,
    ) -> Self {
        Self {
            phase,
            monotonic_counter,
            last_progress_seq,
            resources,
        }
    }

    #[must_use]
    pub const fn phase(&self) -> wire::RunnerPulsePhase {
        self.phase
    }

    #[must_use]
    pub const fn monotonic_counter(&self) -> u64 {
        self.monotonic_counter
    }

    #[must_use]
    pub const fn last_progress_seq(&self) -> u64 {
        self.last_progress_seq
    }

    #[must_use]
    pub const fn resources(&self) -> &wire::ResourceSample {
        &self.resources
    }
}

pub(super) fn validate_phase(value: i32) -> Result<wire::RunnerPulsePhase, RunnerPulseError> {
    let phase =
        wire::RunnerPulsePhase::try_from(value).map_err(|_| RunnerPulseError::InvalidPhase)?;
    if phase == wire::RunnerPulsePhase::Unspecified {
        return Err(RunnerPulseError::InvalidPhase);
    }
    Ok(phase)
}

pub(super) const fn validate_resources(
    value: &wire::ResourceSample,
) -> Result<(), RunnerPulseError> {
    if value.process_count == 0 || value.peak_resident_memory_bytes < value.resident_memory_bytes {
        return Err(RunnerPulseError::InvalidResources);
    }
    Ok(())
}
