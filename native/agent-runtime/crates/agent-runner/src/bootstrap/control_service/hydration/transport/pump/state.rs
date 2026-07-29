use agent_protocol::generated::v1 as wire;

use super::super::super::{RunnerHydrationRequest, VerifiedRunnerHydration};
use super::super::RunnerHydrationTransfer;
use super::{
    HydrationDataPumpError, RunnerHydrationPumpContext, committed_payload, progress_payload,
};

pub(super) struct HydrationPumpState {
    request: Option<RunnerHydrationRequest>,
    transfer: Option<RunnerHydrationTransfer>,
}

pub(super) enum PumpTransition {
    Progress(wire::FramePayload),
    Committed {
        response: wire::FramePayload,
        hydration: VerifiedRunnerHydration,
    },
}

impl HydrationPumpState {
    pub(super) const fn new(request: RunnerHydrationRequest) -> Self {
        Self {
            request: Some(request),
            transfer: None,
        }
    }

    pub(super) fn accept(
        &mut self,
        body: &wire::frame_payload::Body,
        payload_digest: [u8; 32],
        maximum_chunk_bytes: u64,
        context: &RunnerHydrationPumpContext,
    ) -> Result<PumpTransition, HydrationDataPumpError> {
        match (self.transfer.as_mut(), body) {
            (None, wire::frame_payload::Body::HydrationManifest(manifest)) => {
                let request = self
                    .request
                    .take()
                    .ok_or(HydrationDataPumpError::UnexpectedPayload)?;
                let (transfer, cursor) = request.begin_transfer(
                    manifest.clone(),
                    payload_digest,
                    maximum_chunk_bytes,
                )?;
                let response = progress_payload(context, &transfer, cursor);
                self.transfer = Some(transfer);
                Ok(PumpTransition::Progress(response))
            }
            (Some(transfer), wire::frame_payload::Body::HydrationChunk(chunk)) => {
                let cursor = transfer.accept_chunk(chunk)?;
                Ok(PumpTransition::Progress(progress_payload(
                    context, transfer, cursor,
                )))
            }
            (Some(_), wire::frame_payload::Body::HydrationComplete(complete)) => {
                let transfer = self
                    .transfer
                    .take()
                    .ok_or(HydrationDataPumpError::UnexpectedPayload)?;
                let hydration = transfer.finish(complete)?;
                Ok(PumpTransition::Committed {
                    response: committed_payload(context, complete),
                    hydration,
                })
            }
            _ => Err(HydrationDataPumpError::UnexpectedPayload),
        }
    }
}

#[cfg(test)]
mod tests;
