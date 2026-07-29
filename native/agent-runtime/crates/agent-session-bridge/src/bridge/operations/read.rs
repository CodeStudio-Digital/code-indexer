use agent_protocol::generated::v1 as wire;
use agent_session_store::{OperationId, ReadCommittedPayloadRequest};

use super::super::AuthenticatedSessionStoreBridge;
use super::super::failure::from_store;
use crate::convert::{authority_from_wire, commit_receipt_to_wire, kind_from_wire};

const RESPONSE_ENVELOPE_RESERVE_BYTES: usize = 1024;

impl AuthenticatedSessionStoreBridge {
    pub(super) fn read_committed_payload(
        &mut self,
        request: wire::ReadCommittedSessionPayload,
    ) -> wire::SessionStoreResponse {
        let parsed = (|| {
            let authority = authority_from_wire(request.authority)?;
            let operation_id = OperationId::parse(request.operation_id)?;
            let kind = kind_from_wire(request.kind)?;
            let expected_payload_sha256: [u8; 32] = request
                .expected_payload_sha256
                .try_into()
                .map_err(|_| agent_session_store::SessionStoreError::DivergentReplay)?;
            let maximum_payload_bytes = u64::try_from(
                self.max_frame_bytes
                    .saturating_sub(RESPONSE_ENVELOPE_RESERVE_BYTES),
            )
            .map_err(|_| agent_session_store::SessionStoreError::PayloadLimitExceeded)?;
            let entry = self
                .writers
                .get_mut(&request.writer_handle)
                .ok_or(agent_session_store::SessionStoreError::StaleAuthority)?;
            if entry.authority != authority {
                return Err(agent_session_store::SessionStoreError::StaleAuthority);
            }
            let payload = entry
                .journal
                .read_committed_payload(ReadCommittedPayloadRequest {
                    operation_id: &operation_id,
                    kind,
                    expected_payload_sha256,
                    expected_payload_bytes: request.expected_payload_bytes,
                    maximum_payload_bytes,
                })?;
            let (receipt, encoded_payload) = payload.into_parts();
            Ok(wire::SessionStoreResponse {
                body: Some(wire::session_store_response::Body::CommittedSessionPayload(
                    wire::CommittedSessionPayload {
                        commit_receipt: Some(commit_receipt_to_wire(&receipt, false)),
                        encoded_payload,
                    },
                )),
            })
        })();
        parsed.unwrap_or_else(|error| from_store(&error))
    }
}
