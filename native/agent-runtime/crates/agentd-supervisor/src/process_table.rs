mod authority;
mod entries;
mod model;
mod operations;
mod reap;
mod receipt;

use std::collections::BTreeMap;
use std::time::Duration;

use agent_platform::containment::{
    ContainmentPort, PhysicalReapEvidence, ProcessId, ReapFailure, ResourceGroupId,
};
use agent_protocol::identity::{AttemptId, AttemptIdentity};

use crate::admission::{AdmissionLedger, SupervisorCapacity};
use entries::{
    BootstrapPending, Cancelling, Entry, Exited, Launching, Owned, Physical, Quarantined, Reaping,
    Reserved, Running,
};
pub use model::PhysicalSpawnReceipt;
pub use model::ReapAfterCleanupError;
pub use model::{
    AttemptRuntimeMetadata, ContainmentOperationError, ObservedExit, OwnershipError, OwnershipKey,
    PhysicalState, ReapedAttempt, ReserveOutcome,
};
pub use operations::{
    PendingSpawn, PendingSpawnFinishError, PendingSpawnReservation, SpawnHandoffState,
    execute_contained_spawn,
};

#[cfg(test)]
#[allow(
    clippy::redundant_pub_crate,
    reason = "cross-module tests need a receipt that only process_table may construct"
)]
pub(crate) fn reaped_attempt_for_test(
    metadata: AttemptRuntimeMetadata,
    peak_job_memory_bytes: u64,
) -> ReapedAttempt {
    ReapedAttempt::new(
        metadata,
        ProcessId(41),
        0xE000_0001,
        peak_job_memory_bytes,
        agent_platform::containment::ContainmentReport {
            level: agent_platform::containment::ContainmentLevel::Unavailable,
            enforced_limits: Vec::new(),
            unsupported_limits: Vec::new(),
            capabilities: agent_platform::containment::ContainmentCapabilities::default(),
        },
        ObservedExit {
            exit_code: 0xE000_0001,
            observed_at_unix_ms: 2_000,
        },
    )
}

#[derive(Debug)]
struct VerifiedReap {
    resource_group_id: ResourceGroupId,
    process_id: ProcessId,
    exit_code: u32,
    peak_job_memory_bytes: u64,
}

impl From<PhysicalReapEvidence> for VerifiedReap {
    fn from(evidence: PhysicalReapEvidence) -> Self {
        Self {
            resource_group_id: evidence.resource_group_id().clone(),
            process_id: evidence.process_id(),
            exit_code: evidence.exit_code(),
            peak_job_memory_bytes: evidence.peak_job_memory_bytes(),
        }
    }
}

trait ReapBackend<G> {
    type Error;

    fn reap(
        &self,
        group: G,
        timeout: Duration,
    ) -> Result<VerifiedReap, ReapFailure<G, Self::Error>>;
}

#[derive(Debug)]
struct PlatformReaper<'a, P>(&'a P);

impl<P> ReapBackend<P::Group> for PlatformReaper<'_, P>
where
    P: ContainmentPort,
{
    type Error = P::Error;

    fn reap(
        &self,
        group: P::Group,
        timeout: Duration,
    ) -> Result<VerifiedReap, ReapFailure<P::Group, Self::Error>> {
        self.0.reap_group(group, timeout).map(VerifiedReap::from)
    }
}

/// Bounded owner of every admitted attempt and its physical resource group.
#[derive(Debug)]
pub struct OwnershipRegistry<G> {
    capacity: usize,
    entries: BTreeMap<AttemptId, Entry<G>>,
    admission: AdmissionLedger,
}

impl<G> OwnershipRegistry<G> {
    /// Creates an empty registry and its private admission ledger.
    ///
    /// # Errors
    ///
    /// Returns [`OwnershipError::Admission`] for invalid aggregate limits.
    pub fn new(capacity: SupervisorCapacity) -> Result<Self, OwnershipError> {
        let admission = AdmissionLedger::new(capacity).map_err(OwnershipError::Admission)?;
        Ok(Self {
            capacity: capacity.max_active_attempts as usize,
            entries: BTreeMap::new(),
            admission,
        })
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    #[must_use]
    pub const fn reserved_memory_bytes(&self) -> u64 {
        self.admission.reserved_memory_bytes()
    }

    #[must_use]
    pub const fn reserved_processes(&self) -> u32 {
        self.admission.reserved_processes()
    }

    /// Returns the current physical state for exact current ownership.
    ///
    /// # Errors
    ///
    /// Rejects a missing attempt or stale identity, fence, or runtime.
    pub fn state(&self, key: &OwnershipKey) -> Result<PhysicalState, OwnershipError> {
        self.matching(key).map(Entry::state)
    }

    pub(crate) fn key_for_identity(
        &self,
        identity: &AttemptIdentity,
    ) -> Result<OwnershipKey, OwnershipError> {
        let entry = self
            .entries
            .get(&identity.attempt_id)
            .ok_or(OwnershipError::MissingAttempt)?;
        if entry.metadata().identity != *identity {
            return Err(OwnershipError::StaleOwnership);
        }
        Ok(OwnershipKey::from_metadata(entry.metadata()))
    }

    pub(crate) fn metadata(
        &self,
        key: &OwnershipKey,
    ) -> Result<&AttemptRuntimeMetadata, OwnershipError> {
        self.matching(key).map(Entry::metadata)
    }

    fn matching(&self, key: &OwnershipKey) -> Result<&Entry<G>, OwnershipError> {
        let entry = self
            .entries
            .get(key.attempt_id())
            .ok_or(OwnershipError::MissingAttempt)?;
        if !key.matches(entry.metadata()) {
            return Err(OwnershipError::StaleOwnership);
        }
        Ok(entry)
    }

    fn take_matching(&mut self, key: &OwnershipKey) -> Result<Entry<G>, OwnershipError> {
        self.matching(key)?;
        self.entries
            .remove(key.attempt_id())
            .ok_or(OwnershipError::MissingAttempt)
    }

    fn restore(&mut self, entry: Entry<G>) {
        let attempt_id = entry.metadata().identity.attempt_id.clone();
        let replaced = self.entries.insert(attempt_id, entry);
        debug_assert!(replaced.is_none(), "ownership slot unexpectedly occupied");
    }
}

#[cfg(test)]
mod tests;
