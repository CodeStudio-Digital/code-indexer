use std::sync::Arc;

use crate::generated::v1 as wire;
use crate::management_channel::channel::validation::{
    validate_management_body, validate_response_correlation,
};
use crate::management_channel::clock::ManagementClockAuthority;
use crate::management_channel::receiver::{
    ManagementReceiver, ManagementReceiverOutcome, PendingManagementInbound,
};
use crate::management_channel::sender::{ManagementOutboundAuthority, PendingManagementOutbound};
use crate::management_channel::{
    ManagementChannelError, ManagementDeadlinePolicy, ManagementPayloadKind,
    ManagementSessionPolicy, ReplayedManagementFrame,
};
use crate::management_secrets::scrub_protected_body;

use super::command::AsyncSentManagementFrame;
use super::event::AsyncAcknowledgedManagementInbound;

mod deadlines;
mod prepared;

pub(super) use prepared::{PreparedResponse, PreparedWrite};

pub(super) enum InboundAction {
    Pending(Box<PendingManagementInbound>),
    Acknowledged(AsyncAcknowledgedManagementInbound),
    Replay {
        metadata: ReplayedManagementFrame,
        response: Option<Arc<[u8]>>,
    },
}

pub(super) struct ManagementSemantics {
    receiver: ManagementReceiver,
    sender: ManagementOutboundAuthority,
    session: ManagementSessionPolicy,
    clock: ManagementClockAuthority,
    deadline: ManagementDeadlinePolicy,
}

impl ManagementSemantics {
    pub(super) fn new(
        receiver: ManagementReceiver,
        sender: ManagementOutboundAuthority,
        session: ManagementSessionPolicy,
        clock: ManagementClockAuthority,
    ) -> Result<Self, ManagementChannelError> {
        let deadline = ManagementDeadlinePolicy::new(session.frame_limits().write_timeout_ms)?;
        Ok(Self {
            receiver,
            sender,
            session,
            clock,
            deadline,
        })
    }

    pub(super) fn can_dispatch(&self) -> bool {
        self.sender.has_outstanding_capacity()
    }

    pub(super) fn begin_inbound(
        &mut self,
        encoded: &[u8],
    ) -> Result<InboundAction, ManagementChannelError> {
        let observed_at = self.clock.now_unix_ms();
        let outcome = self.receiver.begin_receive(encoded, observed_at)?;
        match outcome {
            ManagementReceiverOutcome::Replay { metadata, response } => {
                Ok(InboundAction::Replay { metadata, response })
            }
            ManagementReceiverOutcome::Pending(pending) => {
                let body = pending
                    .body()
                    .ok_or(ManagementChannelError::PendingPayloadConsumed)?;
                validate_management_body(
                    &self.session,
                    self.sender.connection(),
                    body,
                    observed_at,
                )?;
                self.sender.validate_inbound_response(
                    pending.reply_to_message_id(),
                    body,
                    observed_at,
                )?;
                if pending.kind() == ManagementPayloadKind::ManagementAck {
                    let acknowledgement = match body {
                        wire::management_payload::Body::ManagementAck(value) => value.clone(),
                        _ => unreachable!("kind and body were derived together"),
                    };
                    let reply_to = pending.reply_to_message_id().map(str::to_owned);
                    let committed = self.receiver.commit(*pending, None)?;
                    self.sender.complete_inbound_response(reply_to.as_deref());
                    Ok(InboundAction::Acknowledged(
                        AsyncAcknowledgedManagementInbound::new(committed, acknowledgement),
                    ))
                } else {
                    Ok(InboundAction::Pending(pending))
                }
            }
        }
    }

    pub(super) fn prepare_new(
        &mut self,
        mut payload: wire::ManagementPayload,
    ) -> Result<PreparedWrite, ManagementChannelError> {
        let sent_at = self.clock.now_unix_ms();
        let result = self.prepare_new_inner(&payload, sent_at);
        if let Some(body) = &mut payload.body {
            scrub_protected_body(body);
        }
        result.map(PreparedWrite::new)
    }

    fn prepare_new_inner(
        &mut self,
        payload: &wire::ManagementPayload,
        sent_at: i64,
    ) -> Result<PendingManagementOutbound, ManagementChannelError> {
        let body = payload
            .body
            .as_ref()
            .ok_or(crate::management_frame::ManagementFrameError::MissingPayloadBody)?;
        validate_management_body(&self.session, self.sender.connection(), body, sent_at)?;
        let outbound = self.sender.prepare(payload, None, self.deadline, sent_at)?;
        self.sender.validate(&outbound)?;
        Ok(outbound)
    }

    pub(super) fn commit_new(&mut self, prepared: PreparedWrite) -> AsyncSentManagementFrame {
        let sent = prepared.sent_metadata();
        self.sender.commit(prepared.into_outbound());
        sent
    }

    pub(super) fn prepare_response(
        &mut self,
        inbound: Box<PendingManagementInbound>,
        mut payload: wire::ManagementPayload,
    ) -> Result<PreparedResponse, ManagementChannelError> {
        self.ensure_pending_live(&inbound)?;
        let sent_at = self.clock.now_unix_ms();
        let result = self.prepare_response_inner(inbound, &payload, sent_at);
        if let Some(body) = &mut payload.body {
            scrub_protected_body(body);
        }
        result
    }

    pub(super) fn prepare_ack(
        &mut self,
        inbound: Box<PendingManagementInbound>,
    ) -> Result<PreparedResponse, ManagementChannelError> {
        let payload = wire::ManagementPayload {
            body: Some(wire::management_payload::Body::ManagementAck(
                wire::ManagementAck {
                    acknowledged_message_id: inbound.message_id().to_owned(),
                    acknowledged_payload_sha256: inbound.payload_digest().to_vec(),
                    acknowledged_at_unix_ms: self.clock.now_unix_ms(),
                },
            )),
        };
        self.prepare_response(inbound, payload)
    }

    fn prepare_response_inner(
        &mut self,
        inbound: Box<PendingManagementInbound>,
        payload: &wire::ManagementPayload,
        sent_at: i64,
    ) -> Result<PreparedResponse, ManagementChannelError> {
        let body = payload
            .body
            .as_ref()
            .ok_or(crate::management_frame::ManagementFrameError::MissingPayloadBody)?;
        validate_management_body(&self.session, self.sender.connection(), body, sent_at)?;
        validate_response_correlation(self.sender.connection(), &inbound, payload, sent_at)?;
        let inbound_reply_to = inbound.reply_to_message_id().map(str::to_owned);
        let outbound = self.sender.prepare(
            payload,
            Some(inbound.message_id().to_owned()),
            self.deadline,
            sent_at,
        )?;
        self.sender.validate(&outbound)?;
        Ok(PreparedResponse::new(inbound, inbound_reply_to, outbound))
    }

    pub(super) fn commit_response(
        &mut self,
        prepared: PreparedResponse,
    ) -> Result<AsyncSentManagementFrame, ManagementChannelError> {
        self.ensure_pending_live(prepared.inbound())?;
        let sent = prepared.sent_metadata();
        let (inbound, inbound_reply_to, replay, outbound) = prepared.into_parts();
        self.receiver.commit(*inbound, Some(replay))?;
        self.sender
            .complete_inbound_response(inbound_reply_to.as_deref());
        self.sender.commit(outbound);
        Ok(sent)
    }

    pub(super) fn reject(
        &mut self,
        inbound: Box<PendingManagementInbound>,
    ) -> Result<(), ManagementChannelError> {
        let result = self.receiver.reject(*inbound);
        self.sender.poison();
        result
    }

    pub(super) fn poison(&mut self) {
        self.receiver.poison();
        self.sender.poison();
    }
}
