use std::error::Error;
use std::fmt::{self, Display, Formatter};

use agent_platform::containment::{ContainmentReport, ProcessId, ResourceGroupId};
use agent_protocol::identity::{AttemptId, AttemptIdentity, RuntimeInstanceId};

use crate::admission::AdmissionError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PhysicalState {
    /// Aggregate resources and a contained runner group are owned, but the
    /// attempt has not been activated.
    Reserved,
    /// The contained runner is activated.
    Running,
    /// Tree termination was requested and ownership is retained.
    Cancelling,
    /// The root exit was observed while descendants may still exist.
    Exited,
    /// A reap is pending or a prior reap attempt timed out.
    Reaping,
    /// Physical proof or admission release failed irrecoverably. Bounded
    /// ownership and ledger accounting remain poisoned so capacity cannot be
    /// reused from untrusted or internally inconsistent proof.
    Quarantined,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttemptRuntimeMetadata {
    pub identity: AttemptIdentity,
    pub runtime_instance_id: RuntimeInstanceId,
    pub resource_group_id: ResourceGroupId,
    pub deadline_at_unix_ms: i64,
    pub lease_expires_at_unix_ms: i64,
    pub cancel_grace_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnershipKey {
    identity: AttemptIdentity,
    runtime_instance_id: RuntimeInstanceId,
}

impl OwnershipKey {
    #[must_use]
    pub fn from_metadata(metadata: &AttemptRuntimeMetadata) -> Self {
        Self {
            identity: metadata.identity.clone(),
            runtime_instance_id: metadata.runtime_instance_id.clone(),
        }
    }

    pub(super) const fn attempt_id(&self) -> &AttemptId {
        &self.identity.attempt_id
    }

    pub(super) fn matches(&self, metadata: &AttemptRuntimeMetadata) -> bool {
        self.identity == metadata.identity
            && self.runtime_instance_id == metadata.runtime_instance_id
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReserveOutcome {
    Reserved,
    AlreadyOwned(PhysicalState),
}

/// Cloneable telemetry derived from an entry that still owns the unique
/// platform group and admission token. It carries no group handle or release
/// authority.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhysicalSpawnReceipt {
    metadata: AttemptRuntimeMetadata,
    reservation_id: String,
    process_id: ProcessId,
    containment_report: ContainmentReport,
}

impl PhysicalSpawnReceipt {
    pub(super) const fn new(
        metadata: AttemptRuntimeMetadata,
        reservation_id: String,
        process_id: ProcessId,
        containment_report: ContainmentReport,
    ) -> Self {
        Self {
            metadata,
            reservation_id,
            process_id,
            containment_report,
        }
    }

    pub(crate) const fn metadata(&self) -> &AttemptRuntimeMetadata {
        &self.metadata
    }

    pub(crate) fn reservation_id(&self) -> &str {
        &self.reservation_id
    }

    pub(crate) const fn process_id(&self) -> ProcessId {
        self.process_id
    }

    pub(crate) const fn containment_report(&self) -> &ContainmentReport {
        &self.containment_report
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObservedExit {
    pub exit_code: u32,
    pub observed_at_unix_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnershipError {
    CapacityExceeded,
    MissingAttempt,
    MissingPhysicalReceipt,
    MissingObservedExit,
    InvalidObservedAt,
    StaleOwnership,
    InvalidTransition {
        from: PhysicalState,
        requested: PhysicalState,
    },
    Admission(AdmissionError),
    AdmissionInvariant(AdmissionError),
    EvidenceAttributionMismatch {
        expected_resource_group_id: ResourceGroupId,
        evidence_resource_group_id: ResourceGroupId,
        expected_process_id: ProcessId,
        evidence_process_id: ProcessId,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub enum ReapAfterCleanupError<E, G> {
    Operation(ContainmentOperationError<E>),
    PostReapGate(G),
}

impl Display for OwnershipError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(formatter, "supervisor ownership error: {self:?}")
    }
}

impl Error for OwnershipError {}

#[derive(Debug, PartialEq, Eq)]
pub enum ContainmentOperationError<E> {
    Ownership(OwnershipError),
    Platform(E),
}

impl<E: fmt::Debug> Display for ContainmentOperationError<E> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "supervisor containment operation failed: {self:?}"
        )
    }
}

impl<E: Error> Error for ContainmentOperationError<E> {}

/// Telemetry emitted only by a successful physical reap. It is not accepted
/// back by the registry as authority or cleanup proof.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReapedAttempt {
    metadata: AttemptRuntimeMetadata,
    process_id: ProcessId,
    exit_code: u32,
    peak_job_memory_bytes: u64,
    containment_report: ContainmentReport,
    observed_exit: ObservedExit,
}

impl ReapedAttempt {
    #[must_use]
    pub(crate) const fn metadata(&self) -> &AttemptRuntimeMetadata {
        &self.metadata
    }

    #[must_use]
    pub const fn process_id(&self) -> ProcessId {
        self.process_id
    }

    #[must_use]
    pub const fn exit_code(&self) -> u32 {
        self.exit_code
    }

    #[must_use]
    pub const fn peak_job_memory_bytes(&self) -> u64 {
        self.peak_job_memory_bytes
    }

    #[must_use]
    pub(crate) const fn containment_report(&self) -> &ContainmentReport {
        &self.containment_report
    }

    #[must_use]
    pub const fn observed_exit(&self) -> ObservedExit {
        self.observed_exit
    }
}

impl ReapedAttempt {
    pub(super) const fn new(
        metadata: AttemptRuntimeMetadata,
        process_id: ProcessId,
        exit_code: u32,
        peak_job_memory_bytes: u64,
        containment_report: ContainmentReport,
        observed_exit: ObservedExit,
    ) -> Self {
        Self {
            metadata,
            process_id,
            exit_code,
            peak_job_memory_bytes,
            containment_report,
            observed_exit,
        }
    }
}
