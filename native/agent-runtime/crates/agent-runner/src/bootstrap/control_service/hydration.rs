use std::error::Error;
use std::fmt::{self, Debug, Display, Formatter};

use agent_protocol::generated::v1 as wire;

use crate::control::EffectivePreparedFacts;
use crate::provider_context::ProviderContextMaterial;

pub(super) mod transport;
mod verification;

pub struct RunnerHydratedSnapshot {
    reference: wire::SnapshotRef,
    encoded_payload: Vec<u8>,
}

pub struct RunnerHydratedArtifact {
    reference: wire::ArtifactRef,
    encoded_payload: Vec<u8>,
}

pub struct RunnerHydrationRequest {
    expected_snapshots: Vec<wire::SnapshotRef>,
    expected_artifacts: Vec<wire::ArtifactRef>,
    resource_budget: wire::ResourceBudget,
}

pub struct VerifiedRunnerHydration {
    snapshots: Vec<RunnerHydratedSnapshot>,
    artifacts: Vec<RunnerHydratedArtifact>,
    hydrated_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerHydrationError {
    SnapshotCoverage,
    ArtifactCoverage,
    SnapshotMetadata,
    ArtifactMetadata,
    EmptySnapshot,
    ArtifactLength,
    ArtifactBudget,
    ContentHash,
    ByteBudget,
}

impl RunnerHydrationRequest {
    pub(super) const fn new(
        expected_snapshots: Vec<wire::SnapshotRef>,
        expected_artifacts: Vec<wire::ArtifactRef>,
        resource_budget: wire::ResourceBudget,
    ) -> Self {
        Self {
            expected_snapshots,
            expected_artifacts,
            resource_budget,
        }
    }
}

impl VerifiedRunnerHydration {
    pub(super) fn effective_facts(
        &self,
        resource_budget: wire::ResourceBudget,
        containment: wire::ContainmentReport,
        ready_at_unix_ms: i64,
    ) -> EffectivePreparedFacts {
        EffectivePreparedFacts::from_verified_platform(
            self.snapshots
                .iter()
                .map(|snapshot| snapshot.reference.clone())
                .collect(),
            self.artifacts
                .iter()
                .map(|artifact| artifact.reference.clone())
                .collect(),
            resource_budget,
            containment,
            ready_at_unix_ms,
        )
    }
}

impl ProviderContextMaterial for VerifiedRunnerHydration {
    fn snapshot_payload(&self, reference: &wire::SnapshotRef) -> Option<&[u8]> {
        self.snapshots
            .iter()
            .find(|snapshot| &snapshot.reference == reference)
            .map(|snapshot| snapshot.encoded_payload.as_slice())
    }

    fn artifact_payload(&self, reference: &wire::ArtifactRef) -> Option<&[u8]> {
        self.artifacts
            .iter()
            .find(|artifact| &artifact.reference == reference)
            .map(|artifact| artifact.encoded_payload.as_slice())
    }
}

impl Debug for RunnerHydratedSnapshot {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunnerHydratedSnapshot")
            .field("reference", &self.reference.r#ref)
            .field("payload_bytes", &self.encoded_payload.len())
            .field("encoded_payload", &"[REDACTED]")
            .finish()
    }
}

impl Debug for RunnerHydratedArtifact {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunnerHydratedArtifact")
            .field("artifact_id", &self.reference.artifact_id)
            .field("payload_bytes", &self.encoded_payload.len())
            .field("encoded_payload", &"[REDACTED]")
            .finish()
    }
}

impl Debug for RunnerHydrationRequest {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunnerHydrationRequest")
            .field("snapshot_count", &self.expected_snapshots.len())
            .field("artifact_count", &self.expected_artifacts.len())
            .field("resource_budget", &"[SEALED]")
            .finish()
    }
}

impl Debug for VerifiedRunnerHydration {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VerifiedRunnerHydration")
            .field("snapshot_count", &self.snapshots.len())
            .field("artifact_count", &self.artifacts.len())
            .field("hydrated_bytes", &self.hydrated_bytes)
            .field("payloads", &"[REDACTED]")
            .finish()
    }
}

impl Display for RunnerHydrationError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(formatter, "runner hydration verification failed: {self:?}")
    }
}

impl Error for RunnerHydrationError {}

impl Drop for RunnerHydratedSnapshot {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.encoded_payload.zeroize();
    }
}

impl Drop for RunnerHydratedArtifact {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.encoded_payload.zeroize();
    }
}

#[cfg(test)]
mod tests;
