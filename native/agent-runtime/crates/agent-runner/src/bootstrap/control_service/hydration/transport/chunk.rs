use agent_protocol::generated::v1 as wire;
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use super::super::{RunnerHydratedArtifact, RunnerHydratedSnapshot, VerifiedRunnerHydration};
use super::{HydrationCursor, HydrationTransportError, RunnerHydrationTransfer};

impl RunnerHydrationTransfer {
    pub(super) fn accept_chunk(
        &mut self,
        chunk: &wire::HydrationChunk,
    ) -> Result<HydrationCursor, HydrationTransportError> {
        if self.poisoned {
            return Err(HydrationTransportError::Poisoned);
        }
        let result = self.accept_chunk_unpoisoned(chunk);
        if result.is_err() {
            self.poisoned = true;
            self.current_payload.zeroize();
        }
        result
    }

    fn accept_chunk_unpoisoned(
        &mut self,
        chunk: &wire::HydrationChunk,
    ) -> Result<HydrationCursor, HydrationTransportError> {
        self.validate_binding(&chunk.transfer_id, &chunk.manifest_payload_sha256)?;
        if usize::try_from(chunk.item_ordinal).ok() != Some(self.next_item)
            || chunk.offset
                != u64::try_from(self.current_payload.len())
                    .map_err(|_| HydrationTransportError::ChunkOrder)?
        {
            return Err(HydrationTransportError::ChunkOrder);
        }
        if chunk.encoded_chunk.is_empty() {
            return Err(HydrationTransportError::EmptyChunk);
        }
        let chunk_bytes = u64::try_from(chunk.encoded_chunk.len())
            .map_err(|_| HydrationTransportError::ChunkLimit)?;
        if chunk_bytes > self.plan.max_chunk_bytes {
            return Err(HydrationTransportError::ChunkLimit);
        }
        if chunk.chunk_sha256.len() != 32
            || Sha256::digest(&chunk.encoded_chunk).as_slice() != chunk.chunk_sha256
        {
            return Err(HydrationTransportError::ChunkHash);
        }
        let planned_bytes = self.planned_item_bytes()?;
        let remaining = planned_bytes
            .checked_sub(chunk.offset)
            .ok_or(HydrationTransportError::ItemBoundary)?;
        if chunk_bytes != remaining.min(self.plan.max_chunk_bytes) {
            return Err(HydrationTransportError::ChunkLimit);
        }
        let next_offset = chunk
            .offset
            .checked_add(chunk_bytes)
            .ok_or(HydrationTransportError::ItemBoundary)?;
        if next_offset > planned_bytes || chunk.end_of_item != (next_offset == planned_bytes) {
            return Err(HydrationTransportError::ItemBoundary);
        }
        self.current_payload
            .try_reserve_exact(chunk.encoded_chunk.len())
            .map_err(|_| HydrationTransportError::Allocation)?;
        self.current_payload.extend_from_slice(&chunk.encoded_chunk);
        self.accepted_payload_bytes = self
            .accepted_payload_bytes
            .checked_add(chunk_bytes)
            .ok_or(HydrationTransportError::ManifestByteBudget)?;
        if chunk.end_of_item {
            self.commit_current_item()?;
        }
        self.cursor()
    }

    pub(super) fn finish(
        mut self,
        complete: &wire::HydrationComplete,
    ) -> Result<VerifiedRunnerHydration, HydrationTransportError> {
        if self.poisoned {
            return Err(HydrationTransportError::Poisoned);
        }
        self.validate_binding(&complete.transfer_id, &complete.manifest_payload_sha256)?;
        if usize::try_from(complete.item_count).ok() != Some(self.plan.items.len())
            || complete.total_payload_bytes != self.plan.total_payload_bytes
            || self.next_item != self.plan.items.len()
            || !self.current_payload.is_empty()
            || self.accepted_payload_bytes != self.plan.total_payload_bytes
        {
            return Err(HydrationTransportError::IncompleteTransfer);
        }
        let request = self
            .request
            .take()
            .ok_or(HydrationTransportError::Poisoned)?;
        request
            .verify(
                std::mem::take(&mut self.snapshots),
                std::mem::take(&mut self.artifacts),
            )
            .map_err(Into::into)
    }

    fn validate_binding(
        &self,
        transfer_id: &str,
        manifest_payload_sha256: &[u8],
    ) -> Result<(), HydrationTransportError> {
        if transfer_id != self.transfer_id {
            return Err(HydrationTransportError::TransferMismatch);
        }
        if manifest_payload_sha256 != self.manifest_payload_sha256 {
            return Err(HydrationTransportError::ManifestDigestMismatch);
        }
        Ok(())
    }

    fn planned_item_bytes(&self) -> Result<u64, HydrationTransportError> {
        self.plan
            .items
            .get(self.next_item)
            .map(|item| item.byte_length)
            .ok_or(HydrationTransportError::ChunkOrder)
    }

    fn commit_current_item(&mut self) -> Result<(), HydrationTransportError> {
        let reference = self
            .plan
            .items
            .get(self.next_item)
            .ok_or(HydrationTransportError::ChunkOrder)?
            .reference
            .clone();
        let encoded_payload = std::mem::take(&mut self.current_payload);
        match reference {
            wire::hydration_item::Reference::Snapshot(reference) => {
                self.snapshots.push(RunnerHydratedSnapshot {
                    reference,
                    encoded_payload,
                });
            }
            wire::hydration_item::Reference::Artifact(reference) => {
                self.artifacts.push(RunnerHydratedArtifact {
                    reference,
                    encoded_payload,
                });
            }
        }
        self.next_item = self
            .next_item
            .checked_add(1)
            .ok_or(HydrationTransportError::ChunkOrder)?;
        Ok(())
    }

    fn cursor(&self) -> Result<HydrationCursor, HydrationTransportError> {
        let next_item_ordinal =
            u32::try_from(self.next_item).map_err(|_| HydrationTransportError::ChunkOrder)?;
        let next_offset = u64::try_from(self.current_payload.len())
            .map_err(|_| HydrationTransportError::ChunkOrder)?;
        let max_next_chunk_bytes = if self.next_item == self.plan.items.len() {
            0
        } else {
            self.plan
                .max_chunk_bytes
                .min(self.planned_item_bytes()?.saturating_sub(next_offset))
        };
        Ok(HydrationCursor {
            next_item_ordinal,
            next_offset,
            accepted_payload_bytes: self.accepted_payload_bytes,
            max_next_chunk_bytes,
        })
    }
}
