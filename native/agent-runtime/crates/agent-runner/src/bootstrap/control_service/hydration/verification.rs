use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use super::{
    RunnerHydratedArtifact, RunnerHydratedSnapshot, RunnerHydrationError, RunnerHydrationRequest,
    VerifiedRunnerHydration,
};

impl RunnerHydrationRequest {
    /// Consumes the one-shot manifest and verifies exact bytes under the
    /// attempt's sealed IPC and artifact budgets.
    ///
    /// # Errors
    ///
    /// Rejects missing, duplicate, extra, divergent, empty, oversized, or
    /// hash-mismatched inputs.
    pub fn verify(
        self,
        snapshots: Vec<RunnerHydratedSnapshot>,
        artifacts: Vec<RunnerHydratedArtifact>,
    ) -> Result<VerifiedRunnerHydration, RunnerHydrationError> {
        let mut snapshots = snapshot_map(snapshots)?;
        let mut artifacts = artifact_map(artifacts)?;
        let mut hydrated_bytes = 0_u64;
        let mut verified_snapshots = Vec::with_capacity(self.expected_snapshots.len());
        for expected in self.expected_snapshots {
            let actual = snapshots
                .remove(&expected.r#ref)
                .ok_or(RunnerHydrationError::SnapshotCoverage)?;
            if actual.reference != expected {
                return Err(RunnerHydrationError::SnapshotMetadata);
            }
            if actual.encoded_payload.is_empty() {
                return Err(RunnerHydrationError::EmptySnapshot);
            }
            verify_hash(&actual.encoded_payload, &expected.content_sha256)?;
            add_bytes(
                &mut hydrated_bytes,
                actual.encoded_payload.len(),
                self.resource_budget.max_ipc_bytes,
            )?;
            verified_snapshots.push(actual);
        }
        if !snapshots.is_empty() {
            return Err(RunnerHydrationError::SnapshotCoverage);
        }
        let mut verified_artifacts = Vec::with_capacity(self.expected_artifacts.len());
        let mut artifact_bytes = 0_u64;
        for expected in self.expected_artifacts {
            let actual = artifacts
                .remove(&expected.artifact_id)
                .ok_or(RunnerHydrationError::ArtifactCoverage)?;
            if actual.reference != expected {
                return Err(RunnerHydrationError::ArtifactMetadata);
            }
            let actual_bytes = u64::try_from(actual.encoded_payload.len())
                .map_err(|_| RunnerHydrationError::ByteBudget)?;
            if actual_bytes != expected.byte_length
                || actual_bytes > self.resource_budget.max_artifact_bytes
            {
                return Err(RunnerHydrationError::ArtifactLength);
            }
            artifact_bytes = artifact_bytes
                .checked_add(actual_bytes)
                .ok_or(RunnerHydrationError::ArtifactBudget)?;
            if artifact_bytes > self.resource_budget.max_spool_bytes {
                return Err(RunnerHydrationError::ArtifactBudget);
            }
            verify_hash(&actual.encoded_payload, &expected.content_sha256)?;
            add_bytes(
                &mut hydrated_bytes,
                actual.encoded_payload.len(),
                self.resource_budget.max_ipc_bytes,
            )?;
            verified_artifacts.push(actual);
        }
        if !artifacts.is_empty() {
            return Err(RunnerHydrationError::ArtifactCoverage);
        }
        Ok(VerifiedRunnerHydration {
            snapshots: verified_snapshots,
            artifacts: verified_artifacts,
            hydrated_bytes,
        })
    }
}

fn snapshot_map(
    snapshots: Vec<RunnerHydratedSnapshot>,
) -> Result<BTreeMap<String, RunnerHydratedSnapshot>, RunnerHydrationError> {
    let mut indexed = BTreeMap::new();
    for snapshot in snapshots {
        if indexed
            .insert(snapshot.reference.r#ref.clone(), snapshot)
            .is_some()
        {
            return Err(RunnerHydrationError::SnapshotCoverage);
        }
    }
    Ok(indexed)
}

fn artifact_map(
    artifacts: Vec<RunnerHydratedArtifact>,
) -> Result<BTreeMap<String, RunnerHydratedArtifact>, RunnerHydrationError> {
    let mut indexed = BTreeMap::new();
    for artifact in artifacts {
        if indexed
            .insert(artifact.reference.artifact_id.clone(), artifact)
            .is_some()
        {
            return Err(RunnerHydrationError::ArtifactCoverage);
        }
    }
    Ok(indexed)
}

fn verify_hash(payload: &[u8], expected: &[u8]) -> Result<(), RunnerHydrationError> {
    if expected.len() != 32 || Sha256::digest(payload).as_slice() != expected {
        return Err(RunnerHydrationError::ContentHash);
    }
    Ok(())
}

fn add_bytes(
    total: &mut u64,
    payload_bytes: usize,
    maximum_bytes: u64,
) -> Result<(), RunnerHydrationError> {
    *total = total
        .checked_add(u64::try_from(payload_bytes).map_err(|_| RunnerHydrationError::ByteBudget)?)
        .ok_or(RunnerHydrationError::ByteBudget)?;
    if *total > maximum_bytes {
        return Err(RunnerHydrationError::ByteBudget);
    }
    Ok(())
}
