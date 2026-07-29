use crate::generated::v1 as wire;
use crate::identity::ConnectionId;
use crate::management_channel::payload::management_payload_name;
use crate::management_channel::{ManagementChannelError, PendingManagementInbound};

pub(in crate::management_channel) fn validate_response_correlation(
    connection: &ConnectionId,
    inbound: &PendingManagementInbound,
    payload: &wire::ManagementPayload,
    sent_at: i64,
) -> Result<(), ManagementChannelError> {
    let body = payload
        .body
        .as_ref()
        .ok_or(crate::management_frame::ManagementFrameError::MissingPayloadBody)?;
    let inbound_kind = inbound.kind();
    if !crate::management_channel::direction::response_payload_allowed(inbound_kind, body) {
        return Err(ManagementChannelError::InvalidResponseCorrelation {
            inbound: inbound_kind.name(),
            outbound: management_payload_name(body),
        });
    }
    let request_sent_at = inbound.header().sent_at_unix_ms;
    let response_time = response_timestamp(body);
    if !response_time.is_some_and(|value| value >= request_sent_at && value <= sent_at) {
        return Err(ManagementChannelError::InvalidResponseSemantics {
            payload: management_payload_name(body),
            field: "response_timestamp",
        });
    }
    match body {
        wire::management_payload::Body::ManagementAck(value)
            if value.acknowledged_message_id != inbound.message_id()
                || value.acknowledged_payload_sha256.as_slice() != inbound.payload_digest() =>
        {
            Err(ManagementChannelError::InvalidAcknowledgement)
        }
        wire::management_payload::Body::LaunchAccepted(value)
            if !inbound
                .launch_correlation()
                .is_some_and(|launch| launch.accepts(value)) =>
        {
            Err(ManagementChannelError::InvalidResponseSemantics {
                payload: "LaunchAccepted",
                field: "identity_budget_or_deadline",
            })
        }
        wire::management_payload::Body::LaunchRejected(value)
            if !inbound
                .launch_correlation()
                .is_some_and(|launch| launch.rejects(value)) =>
        {
            Err(ManagementChannelError::InvalidResponseSemantics {
                payload: "LaunchRejected",
                field: "identity",
            })
        }
        wire::management_payload::Body::SupervisorState(value)
            if value.connection_id != connection.as_str() =>
        {
            Err(ManagementChannelError::InvalidResponseSemantics {
                payload: "SupervisorState",
                field: "connection_id",
            })
        }
        _ => Ok(()),
    }
}

const fn response_timestamp(body: &wire::management_payload::Body) -> Option<i64> {
    match body {
        wire::management_payload::Body::LaunchAccepted(value) => Some(value.accepted_at_unix_ms),
        wire::management_payload::Body::LaunchRejected(value) => Some(value.rejected_at_unix_ms),
        wire::management_payload::Body::SupervisorState(value) => Some(value.observed_at_unix_ms),
        wire::management_payload::Body::ManagementAck(value) => Some(value.acknowledged_at_unix_ms),
        _ => None,
    }
}
