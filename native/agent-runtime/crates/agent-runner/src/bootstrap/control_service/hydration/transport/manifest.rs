use agent_protocol::generated::v1 as wire;

use super::super::RunnerHydrationRequest;
use super::HydrationTransportError;

const MAX_TRANSFER_ID_BYTES: usize = 512;

pub(super) struct PlannedItem {
    pub reference: wire::hydration_item::Reference,
    pub byte_length: u64,
}

pub(super) struct HydrationPlan {
    pub items: Vec<PlannedItem>,
    pub total_payload_bytes: u64,
    pub max_chunk_bytes: u64,
}

impl HydrationPlan {
    pub fn first_chunk_credit(&self) -> u64 {
        self.items
            .first()
            .map_or(0, |item| min_u64(self.max_chunk_bytes, item.byte_length))
    }
}

pub(super) fn validate_manifest(
    request: &RunnerHydrationRequest,
    manifest: &wire::HydrationManifest,
    maximum_chunk_bytes: u64,
) -> Result<HydrationPlan, HydrationTransportError> {
    validate_transfer_id(&manifest.transfer_id)?;
    if maximum_chunk_bytes == 0
        || manifest.max_chunk_bytes == 0
        || manifest.max_chunk_bytes > maximum_chunk_bytes
        || manifest.max_chunk_bytes > request.resource_budget.max_ipc_bytes
    {
        return Err(HydrationTransportError::InvalidChunkLimit);
    }
    let expected_count = request
        .expected_snapshots
        .len()
        .checked_add(request.expected_artifacts.len())
        .ok_or(HydrationTransportError::ManifestCoverage)?;
    if manifest.items.len() != expected_count || expected_count == 0 {
        return Err(HydrationTransportError::ManifestCoverage);
    }

    let mut total = 0_u64;
    let mut artifact_total = 0_u64;
    let mut chunk_frames = 0_u64;
    let mut items = Vec::with_capacity(expected_count);
    for (index, item) in manifest.items.iter().enumerate() {
        if usize::try_from(item.ordinal).ok() != Some(index) {
            return Err(HydrationTransportError::ManifestCoverage);
        }
        let reference = item
            .reference
            .as_ref()
            .ok_or(HydrationTransportError::ManifestMetadata)?;
        validate_reference(request, index, reference, item.byte_length)?;
        if matches!(reference, wire::hydration_item::Reference::Artifact(_)) {
            artifact_total = add(artifact_total, item.byte_length)?;
            if artifact_total > request.resource_budget.max_spool_bytes {
                return Err(HydrationTransportError::ManifestByteBudget);
            }
        }
        total = add(total, item.byte_length)?;
        chunk_frames = chunk_frames
            .checked_add(item.byte_length.div_ceil(manifest.max_chunk_bytes))
            .ok_or(HydrationTransportError::ManifestFrameBudget)?;
        items.push(PlannedItem {
            reference: reference.clone(),
            byte_length: item.byte_length,
        });
    }
    if total != manifest.total_payload_bytes
        || total == 0
        || total > request.resource_budget.max_ipc_bytes
    {
        return Err(HydrationTransportError::ManifestByteBudget);
    }
    let transaction_frames = chunk_frames
        .checked_add(3)
        .and_then(|frames| frames.checked_mul(2))
        .ok_or(HydrationTransportError::ManifestFrameBudget)?;
    if transaction_frames > u64::from(request.resource_budget.max_ipc_frames) {
        return Err(HydrationTransportError::ManifestFrameBudget);
    }
    Ok(HydrationPlan {
        items,
        total_payload_bytes: total,
        max_chunk_bytes: manifest.max_chunk_bytes,
    })
}

fn validate_reference(
    request: &RunnerHydrationRequest,
    index: usize,
    reference: &wire::hydration_item::Reference,
    byte_length: u64,
) -> Result<(), HydrationTransportError> {
    if index < request.expected_snapshots.len() {
        let wire::hydration_item::Reference::Snapshot(actual) = reference else {
            return Err(HydrationTransportError::ManifestCoverage);
        };
        if actual != &request.expected_snapshots[index] || byte_length == 0 {
            return Err(HydrationTransportError::ManifestMetadata);
        }
        return Ok(());
    }
    let artifact_index = index - request.expected_snapshots.len();
    let wire::hydration_item::Reference::Artifact(actual) = reference else {
        return Err(HydrationTransportError::ManifestCoverage);
    };
    let expected = &request.expected_artifacts[artifact_index];
    if actual != expected
        || byte_length != expected.byte_length
        || byte_length == 0
        || byte_length > request.resource_budget.max_artifact_bytes
    {
        return Err(HydrationTransportError::ManifestMetadata);
    }
    Ok(())
}

fn validate_transfer_id(value: &str) -> Result<(), HydrationTransportError> {
    if value.is_empty()
        || value.len() > MAX_TRANSFER_ID_BYTES
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(HydrationTransportError::InvalidTransferId);
    }
    Ok(())
}

fn add(left: u64, right: u64) -> Result<u64, HydrationTransportError> {
    left.checked_add(right)
        .ok_or(HydrationTransportError::ManifestByteBudget)
}

const fn min_u64(left: u64, right: u64) -> u64 {
    if left < right { left } else { right }
}
