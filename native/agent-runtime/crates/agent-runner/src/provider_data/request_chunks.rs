use agent_protocol::frame::{CommittedOutbound, FrameReceiveOutcome};
use agent_protocol::generated::v1 as wire;
use prost::Message;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite};
use zeroize::Zeroizing;

use super::validation::validate_accepted;
use super::{ProviderDataClient, ProviderDataClock, ProviderDataError, ProviderDataTiming};

const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_CHUNK_BYTES: usize = 128 * 1024;
const ENVELOPE_RESERVE: usize = 4096;

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> ProviderDataClient<S> {
    pub(super) async fn send_provider_request<C, F>(
        &mut self,
        start: wire::ProviderStart,
        checkpoint: bool,
        timing: ProviderDataTiming,
        clock: &C,
        on_committed: F,
    ) -> Result<CommittedOutbound, ProviderDataError>
    where
        C: ProviderDataClock,
        F: FnOnce() + Send,
    {
        let deadline = start.deadline_at_unix_ms;
        let maximum = self
            .channel
            .maximum_frame_bytes()
            .saturating_sub(ENVELOPE_RESERVE);
        if maximum == 0 || start.encoded_len() > MAX_REQUEST_BYTES {
            return Err(ProviderDataError::InvalidRequest(
                "provider transfer exceeds bounds",
            ));
        }
        if start.encoded_len() <= maximum {
            let payload = wire::FramePayload {
                body: Some(if checkpoint {
                    wire::frame_payload::Body::ProviderCheckpoint(start)
                } else {
                    wire::frame_payload::Body::ProviderStart(start)
                }),
            };
            let receipt = self
                .channel
                .send_new(&payload, deadline, timing.hard_deadline, || {
                    clock.now_unix_ms()
                })
                .await?;
            on_committed();
            return Ok(receipt);
        }
        let bytes = Zeroizing::new(start.encode_to_vec());
        let request_sha256 = Sha256::digest(bytes.as_slice()).to_vec();
        let operation_id = start.operation_id;
        let total_bytes = bytes.len() as u64;
        let chunk_bytes = maximum.min(MAX_CHUNK_BYTES);
        let mut on_committed = Some(on_committed);
        for (index, chunk) in bytes.chunks(chunk_bytes).enumerate() {
            let payload = wire::FramePayload {
                body: Some(wire::frame_payload::Body::ProviderRequestChunk(
                    wire::ProviderRequestChunk {
                        identity: Some(self.identity.clone()),
                        runtime_instance_id: self.runtime_instance_id.clone(),
                        operation_id: operation_id.clone(),
                        total_bytes,
                        request_sha256: request_sha256.clone(),
                        chunk_offset: (index * chunk_bytes) as u64,
                        encoded_chunk: chunk.to_vec(),
                        checkpoint_only: checkpoint,
                    },
                )),
            };
            let receipt = self
                .channel
                .send_new(&payload, deadline, timing.hard_deadline, || {
                    clock.now_unix_ms()
                })
                .await?;
            // Let Control serve cancellation and heartbeat while the remaining
            // parts are transferred. No provider has opened at this boundary.
            if let Some(committed) = on_committed.take() {
                committed();
            }
            self.receive_chunk_accepted(&receipt, &operation_id, timing, clock)
                .await?;
        }
        let payload = wire::FramePayload {
            body: Some(wire::frame_payload::Body::ProviderRequestCommit(
                wire::ProviderRequestCommit {
                    identity: Some(self.identity.clone()),
                    runtime_instance_id: self.runtime_instance_id.clone(),
                    operation_id,
                    total_bytes,
                    request_sha256,
                    checkpoint_only: checkpoint,
                },
            )),
        };
        self.channel
            .send_new(&payload, deadline, timing.hard_deadline, || {
                clock.now_unix_ms()
            })
            .await
            .map_err(Into::into)
    }

    async fn receive_chunk_accepted<C: ProviderDataClock>(
        &mut self,
        request: &CommittedOutbound,
        operation_id: &str,
        timing: ProviderDataTiming,
        clock: &C,
    ) -> Result<(), ProviderDataError> {
        loop {
            let outcome = self
                .channel
                .begin_receive(
                    timing.hard_deadline,
                    timing.hard_deadline,
                    timing.replay_write_timeout,
                    || clock.now_unix_ms(),
                )
                .await?;
            let FrameReceiveOutcome::Pending(mut pending) = outcome else {
                continue;
            };
            let binding = pending.binding();
            let header = pending.header().clone();
            let (body, _) = pending.take_body_and_digest()?;
            let wire::frame_payload::Body::ProviderRequestChunkAccepted(accepted) = body else {
                return Err(ProviderDataError::UnexpectedPayload(
                    "expected provider chunk receipt",
                ));
            };
            validate_accepted(
                wire::frame_payload::Body::ProviderAccepted(accepted),
                &header,
                request,
                operation_id,
                &self.runtime_instance_id,
                clock.now_unix_ms(),
            )?;
            if !self.channel.commit_accepted(*pending)?.matches(&binding) {
                return Err(ProviderDataError::ForeignCommitReceipt);
            }
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests;
