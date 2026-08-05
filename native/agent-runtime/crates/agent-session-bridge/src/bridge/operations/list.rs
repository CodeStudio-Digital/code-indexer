use agent_protocol::generated::v1 as wire;
use agent_session_store::ListCommittedRecordsRequest;

use super::AuthenticatedSessionStoreBridge;
use crate::convert::{authority_from_wire, commit_receipt_to_wire};

impl AuthenticatedSessionStoreBridge {
    pub(super) fn list_committed_records(
        &mut self,
        request: wire::ListCommittedSessionRecords,
    ) -> wire::SessionStoreResponse {
        let parsed = (|| {
            let authority = authority_from_wire(request.authority)?;
            let entry = self
                .writers
                .get_mut(&request.writer_handle)
                .ok_or(agent_session_store::SessionStoreError::StaleAuthority)?;
            if entry.authority != authority {
                return Err(agent_session_store::SessionStoreError::StaleAuthority);
            }
            let page = entry
                .journal
                .list_committed_records(ListCommittedRecordsRequest {
                    after_sequence: request.after_global_sequence,
                    maximum_records: request.max_records,
                })?;
            Ok(wire::SessionStoreResponse {
                body: Some(
                    wire::session_store_response::Body::CommittedSessionRecordPage(
                        wire::CommittedSessionRecordPage {
                            session_id: entry.session_id.as_str().to_owned(),
                            records: page
                                .records()
                                .iter()
                                .map(|receipt| commit_receipt_to_wire(receipt, false))
                                .collect(),
                            next_global_sequence: page.next_sequence(),
                            complete: page.complete(),
                        },
                    ),
                ),
            })
        })();
        parsed.unwrap_or_else(|error| super::from_store(&error))
    }
}
