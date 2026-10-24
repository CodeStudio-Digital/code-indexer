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
            let page_request = ListCommittedRecordsRequest {
                after_sequence: request.after_global_sequence,
                maximum_records: request.max_records,
            };
            let (session_id, page) = if request.reader_handle.is_empty() {
                let entry = self
                    .writers
                    .get_mut(&request.writer_handle)
                    .ok_or(agent_session_store::SessionStoreError::StaleAuthority)?;
                if entry.authority != authority {
                    return Err(agent_session_store::SessionStoreError::StaleAuthority);
                }
                (
                    entry.session_id.as_str().to_owned(),
                    entry
                        .journal
                        .list_committed_snapshot(page_request, &request.snapshot_id)?,
                )
            } else {
                if !request.writer_handle.is_empty() {
                    return Err(agent_session_store::SessionStoreError::InvalidLimits);
                }
                let entry = self
                    .readers
                    .get(&request.reader_handle)
                    .ok_or(agent_session_store::SessionStoreError::StaleAuthority)?;
                if entry.authority != authority {
                    return Err(agent_session_store::SessionStoreError::StaleAuthority);
                }
                (
                    entry.session_id.as_str().to_owned(),
                    entry.view.list(page_request, &request.snapshot_id)?,
                )
            };
            Ok(wire::SessionStoreResponse {
                body: Some(
                    wire::session_store_response::Body::CommittedSessionRecordPage(
                        wire::CommittedSessionRecordPage {
                            session_id,
                            records: page
                                .records()
                                .iter()
                                .map(|receipt| commit_receipt_to_wire(receipt, false))
                                .collect(),
                            next_global_sequence: page.next_sequence(),
                            complete: page.complete(),
                            snapshot_id: page.snapshot_id().to_owned(),
                        },
                    ),
                ),
            })
        })();
        parsed.unwrap_or_else(|error| super::from_store(&error))
    }
}
