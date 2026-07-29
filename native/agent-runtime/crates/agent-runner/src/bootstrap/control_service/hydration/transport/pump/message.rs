use agent_protocol::generated::v1 as wire;
use zeroize::Zeroize;

use super::super::{HydrationCursor, RunnerHydrationTransfer};
use super::RunnerHydrationPumpContext;

pub(super) struct ScrubbedHydrationBody(Option<wire::frame_payload::Body>);

impl ScrubbedHydrationBody {
    pub(super) const fn new(body: wire::frame_payload::Body) -> Self {
        Self(Some(body))
    }

    pub(super) const fn as_ref(&self) -> &wire::frame_payload::Body {
        self.0.as_ref().expect("hydration body is owned")
    }
}

impl Drop for ScrubbedHydrationBody {
    fn drop(&mut self) {
        if let Some(wire::frame_payload::Body::HydrationChunk(chunk)) = self.0.as_mut() {
            chunk.encoded_chunk.zeroize();
            chunk.chunk_sha256.zeroize();
            chunk.manifest_payload_sha256.zeroize();
        }
    }
}

pub(super) fn progress_payload(
    context: &RunnerHydrationPumpContext,
    transfer: &RunnerHydrationTransfer,
    cursor: HydrationCursor,
) -> wire::FramePayload {
    wire::FramePayload {
        body: Some(wire::frame_payload::Body::HydrationProgress(
            wire::HydrationProgress {
                identity: Some(context.wire_identity.clone()),
                runtime_instance_id: context.runtime_instance_id.clone(),
                transfer_id: transfer.transfer_id.clone(),
                manifest_payload_sha256: transfer.manifest_payload_sha256.to_vec(),
                next_item_ordinal: cursor.next_item_ordinal,
                next_offset: cursor.next_offset,
                accepted_payload_bytes: cursor.accepted_payload_bytes,
                max_next_chunk_bytes: cursor.max_next_chunk_bytes,
            },
        )),
    }
}

pub(super) fn committed_payload(
    context: &RunnerHydrationPumpContext,
    complete: &wire::HydrationComplete,
) -> wire::FramePayload {
    wire::FramePayload {
        body: Some(wire::frame_payload::Body::HydrationCommitted(
            wire::HydrationCommitted {
                identity: Some(context.wire_identity.clone()),
                runtime_instance_id: context.runtime_instance_id.clone(),
                transfer_id: complete.transfer_id.clone(),
                manifest_payload_sha256: complete.manifest_payload_sha256.clone(),
                item_count: complete.item_count,
                total_payload_bytes: complete.total_payload_bytes,
            },
        )),
    }
}
