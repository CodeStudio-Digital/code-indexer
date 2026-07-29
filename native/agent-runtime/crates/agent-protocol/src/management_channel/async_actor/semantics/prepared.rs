use std::sync::Arc;

use crate::management_channel::PendingManagementInbound;
use crate::management_channel::async_actor::command::AsyncSentManagementFrame;
use crate::management_channel::sender::PendingManagementOutbound;

pub(in crate::management_channel::async_actor) struct PreparedWrite {
    outbound: PendingManagementOutbound,
}

impl PreparedWrite {
    pub(in crate::management_channel::async_actor) const fn new(
        outbound: PendingManagementOutbound,
    ) -> Self {
        Self { outbound }
    }

    pub(in crate::management_channel::async_actor) fn encoded(&self) -> &[u8] {
        self.outbound.encoded()
    }

    pub(in crate::management_channel::async_actor) const fn deadline_at_unix_ms(&self) -> i64 {
        self.outbound.deadline_at_unix_ms()
    }

    pub(in crate::management_channel::async_actor) fn sent_metadata(
        &self,
    ) -> AsyncSentManagementFrame {
        sent_metadata(&self.outbound)
    }

    pub(in crate::management_channel::async_actor) fn into_outbound(
        self,
    ) -> PendingManagementOutbound {
        self.outbound
    }
}

pub(in crate::management_channel::async_actor) struct PreparedResponse {
    inbound: Box<PendingManagementInbound>,
    inbound_reply_to: Option<String>,
    replay: Arc<[u8]>,
    outbound: PendingManagementOutbound,
}

impl PreparedResponse {
    pub(in crate::management_channel::async_actor) fn new(
        inbound: Box<PendingManagementInbound>,
        inbound_reply_to: Option<String>,
        outbound: PendingManagementOutbound,
    ) -> Self {
        Self {
            inbound,
            inbound_reply_to,
            replay: outbound.shared(),
            outbound,
        }
    }

    pub(in crate::management_channel::async_actor) fn encoded(&self) -> &[u8] {
        self.outbound.encoded()
    }

    pub(in crate::management_channel::async_actor) const fn deadline_at_unix_ms(&self) -> i64 {
        self.outbound.deadline_at_unix_ms()
    }

    pub(in crate::management_channel::async_actor) fn inbound(&self) -> &PendingManagementInbound {
        &self.inbound
    }

    pub(in crate::management_channel::async_actor) fn sent_metadata(
        &self,
    ) -> AsyncSentManagementFrame {
        sent_metadata(&self.outbound)
    }

    pub(in crate::management_channel::async_actor) fn into_parts(
        self,
    ) -> (
        Box<PendingManagementInbound>,
        Option<String>,
        Arc<[u8]>,
        PendingManagementOutbound,
    ) {
        (
            self.inbound,
            self.inbound_reply_to,
            self.replay,
            self.outbound,
        )
    }
}

fn sent_metadata(outbound: &PendingManagementOutbound) -> AsyncSentManagementFrame {
    AsyncSentManagementFrame::new(
        outbound.stream_seq(),
        outbound.message_id().to_owned(),
        *outbound.payload_digest(),
    )
}
