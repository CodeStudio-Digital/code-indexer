use std::fmt::{self, Debug, Formatter};

use agent_protocol::generated::v1 as wire;
use zeroize::Zeroize;

use super::{RunnerHydratedArtifact, RunnerHydratedSnapshot, RunnerHydrationRequest};

mod chunk;
mod error;
mod manifest;
pub(in crate::bootstrap::control_service) mod pump;

use error::HydrationTransportError;
use manifest::{HydrationPlan, validate_manifest};

pub(super) struct RunnerHydrationTransfer {
    request: Option<RunnerHydrationRequest>,
    transfer_id: String,
    manifest_payload_sha256: [u8; 32],
    plan: HydrationPlan,
    next_item: usize,
    current_payload: Vec<u8>,
    accepted_payload_bytes: u64,
    snapshots: Vec<RunnerHydratedSnapshot>,
    artifacts: Vec<RunnerHydratedArtifact>,
    poisoned: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct HydrationCursor {
    pub next_item_ordinal: u32,
    pub next_offset: u64,
    pub accepted_payload_bytes: u64,
    pub max_next_chunk_bytes: u64,
}

impl RunnerHydrationRequest {
    pub(super) fn begin_transfer(
        self,
        manifest: wire::HydrationManifest,
        manifest_payload_sha256: [u8; 32],
        maximum_chunk_bytes: u64,
    ) -> Result<(RunnerHydrationTransfer, HydrationCursor), HydrationTransportError> {
        let plan = validate_manifest(&self, &manifest, maximum_chunk_bytes)?;
        let cursor = HydrationCursor {
            next_item_ordinal: 0,
            next_offset: 0,
            accepted_payload_bytes: 0,
            max_next_chunk_bytes: plan.first_chunk_credit(),
        };
        Ok((
            RunnerHydrationTransfer {
                snapshots: Vec::with_capacity(self.expected_snapshots.len()),
                artifacts: Vec::with_capacity(self.expected_artifacts.len()),
                request: Some(self),
                transfer_id: manifest.transfer_id,
                manifest_payload_sha256,
                plan,
                next_item: 0,
                current_payload: Vec::new(),
                accepted_payload_bytes: 0,
                poisoned: false,
            },
            cursor,
        ))
    }
}

impl Debug for RunnerHydrationTransfer {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunnerHydrationTransfer")
            .field("has_request", &self.request.is_some())
            .field("transfer_id", &self.transfer_id)
            .field("manifest_payload_sha256", &"[BOUND]")
            .field("item_count", &self.plan.items.len())
            .field("next_item", &self.next_item)
            .field("current_payload_bytes", &self.current_payload.len())
            .field("accepted_payload_bytes", &self.accepted_payload_bytes)
            .field("snapshot_count", &self.snapshots.len())
            .field("artifact_count", &self.artifacts.len())
            .field("payloads", &"[REDACTED]")
            .field("poisoned", &self.poisoned)
            .finish()
    }
}

impl Drop for RunnerHydrationTransfer {
    fn drop(&mut self) {
        self.current_payload.zeroize();
    }
}

#[cfg(test)]
mod tests;
