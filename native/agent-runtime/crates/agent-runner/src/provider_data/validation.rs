use agent_protocol::frame::CommittedOutbound;
use agent_protocol::generated::v1 as wire;
use prost::Message;
use sha2::{Digest, Sha256};

use super::{ProviderDataError, ProviderWireEvent};

const LOCAL_PEER_CLOCK_SKEW_MS: i64 = 50;

pub(super) fn validate_start(
    start: &wire::ProviderStart,
    identity: &wire::AttemptIdentity,
) -> Result<(), ProviderDataError> {
    if start.identity.as_ref() != Some(identity) {
        return Err(ProviderDataError::InvalidRequest(
            "attempt identity mismatch",
        ));
    }
    if start.operation_id.is_empty()
        || start.idempotency_key.is_empty()
        || start.deadline_at_unix_ms <= 0
        || start.binding.as_ref().is_none_or(|binding| {
            binding.effective_provider.is_empty() || binding.effective_model.is_empty()
        })
    {
        return Err(ProviderDataError::InvalidRequest(
            "required fields are missing",
        ));
    }
    Ok(())
}

pub(super) fn validate_cancel(
    cancel: &wire::ProviderCancel,
    identity: &wire::AttemptIdentity,
    operation_id: &str,
) -> Result<(), ProviderDataError> {
    if cancel.identity.as_ref() != Some(identity)
        || cancel.operation_id != operation_id
        || cancel.idempotency_key.is_empty()
    {
        return Err(ProviderDataError::InvalidRequest(
            "cancel authority mismatch",
        ));
    }
    Ok(())
}

pub(super) fn validate_engine_proposal(
    proposal: &wire::EngineEventProposal,
    identity: &wire::AttemptIdentity,
    runtime_instance_id: &str,
) -> Result<(), ProviderDataError> {
    let record = proposal
        .record
        .as_ref()
        .ok_or(ProviderDataError::InvalidRequest(
            "engine record is missing",
        ))?;
    let encoded = record.encode_to_vec();
    if proposal.identity.as_ref() != Some(identity)
        || proposal.runtime_instance_id != runtime_instance_id
        || record.schema_version != 1
        || record.identity.as_ref() != Some(identity)
        || record.runtime_instance_id != runtime_instance_id
        || record.local_sequence == 0
        || record.body.is_none()
        || proposal.expected_payload_sha256.len() != 32
        || Sha256::digest(encoded).as_slice() != proposal.expected_payload_sha256
    {
        return Err(ProviderDataError::InvalidRequest(
            "engine proposal authority or digest mismatch",
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn validate_engine_committed(
    body: wire::frame_payload::Body,
    header: &wire::FrameHeader,
    request: &CommittedOutbound,
    identity: &wire::AttemptIdentity,
    runtime_instance_id: &str,
    local_sequence: u64,
    payload_digest: &[u8],
    expected_store: (i32, i32),
) -> Result<wire::CommitSessionRecordReceipt, ProviderDataError> {
    let wire::frame_payload::Body::EngineEventCommitted(committed) = body else {
        return Err(ProviderDataError::UnexpectedPayload(
            "expected EngineEventCommitted",
        ));
    };
    let receipt = committed
        .commit_receipt
        .ok_or(ProviderDataError::Correlation("store receipt is missing"))?;
    if header.reply_to_message_id.as_deref() != Some(request.message_id())
        || committed.identity.as_ref() != Some(identity)
        || committed.runtime_instance_id != runtime_instance_id
        || committed.local_sequence != local_sequence
        || committed.event_payload_sha256 != payload_digest
        || receipt.session_id != identity.session_id
        || receipt.global_sequence == 0
        || (receipt.kind, receipt.durability) != expected_store
        || receipt.payload_sha256 != payload_digest
        || receipt.commit_sha256.len() != 32
        || receipt.previous_commit_sha256.len() != 32
        || receipt.payload_bytes == 0
    {
        return Err(ProviderDataError::Correlation(
            "EngineEventCommitted contradicts proposal",
        ));
    }
    Ok(receipt)
}

pub(super) fn validate_accepted(
    body: wire::frame_payload::Body,
    header: &wire::FrameHeader,
    request: &CommittedOutbound,
    operation_id: &str,
    runtime_instance_id: &str,
    observed_at_unix_ms: i64,
) -> Result<wire::ProviderAccepted, ProviderDataError> {
    let wire::frame_payload::Body::ProviderAccepted(accepted) = body else {
        return Err(ProviderDataError::UnexpectedPayload(
            "expected ProviderAccepted",
        ));
    };
    if header.reply_to_message_id.as_deref() != Some(request.message_id())
        || accepted.operation_id != operation_id
        || accepted.runtime_instance_id != runtime_instance_id
        || accepted.request_payload_sha256.as_slice() != request.payload_digest()
        || !timestamp_within_local_peer(
            accepted.accepted_at_unix_ms,
            request.sent_at_unix_ms(),
            observed_at_unix_ms,
        )
    {
        return Err(ProviderDataError::Correlation(
            "ProviderAccepted contradicts start",
        ));
    }
    Ok(accepted)
}

pub(super) fn timestamp_within_local_peer(actual: i64, earliest: i64, latest: i64) -> bool {
    actual >= earliest.saturating_sub(LOCAL_PEER_CLOCK_SKEW_MS).max(1)
        && actual <= latest.saturating_add(LOCAL_PEER_CLOCK_SKEW_MS)
}

pub(super) fn validate_stream_event(
    body: wire::frame_payload::Body,
    header: &wire::FrameHeader,
    operation_id: &str,
    expected_sequence: u64,
) -> Result<ProviderWireEvent, ProviderDataError> {
    if header.reply_to_message_id.is_some() {
        return Err(ProviderDataError::Correlation(
            "provider event carries reply_to",
        ));
    }
    macro_rules! event {
        ($value:ident, $variant:ident) => {{
            if $value.operation_id != operation_id || $value.event_sequence != expected_sequence {
                return Err(ProviderDataError::Correlation(
                    "provider event sequence mismatch",
                ));
            }
            ProviderWireEvent::$variant($value)
        }};
    }
    Ok(match body {
        wire::frame_payload::Body::ProviderTextDelta(value) => event!(value, Text),
        wire::frame_payload::Body::ProviderThinkingDelta(value) => event!(value, Thinking),
        wire::frame_payload::Body::ProviderToolCall(value) => {
            validate_tool_call(&value)?;
            event!(value, ToolCall)
        }
        wire::frame_payload::Body::ProviderUsage(value) => {
            validate_usage_event(&value)?;
            event!(value, Usage)
        }
        wire::frame_payload::Body::ProviderTerminal(value) => {
            validate_terminal(&value)?;
            event!(value, Terminal)
        }
        _ => {
            return Err(ProviderDataError::UnexpectedPayload(
                "expected provider stream event",
            ));
        }
    })
}

fn validate_tool_call(value: &wire::ProviderToolCall) -> Result<(), ProviderDataError> {
    if value.tool_use_id.is_empty()
        || value.capability_name.is_empty()
        || value.encoded_json_arguments.is_empty()
        || value.arguments_sha256.len() != 32
        || Sha256::digest(&value.encoded_json_arguments).as_slice() != value.arguments_sha256
    {
        return Err(ProviderDataError::UnexpectedPayload(
            "provider tool call is incomplete or corrupt",
        ));
    }
    Ok(())
}

fn validate_usage_event(value: &wire::ProviderUsageEvent) -> Result<(), ProviderDataError> {
    let usage = value
        .usage
        .as_ref()
        .ok_or(ProviderDataError::UnexpectedPayload(
            "provider usage is missing",
        ))?;
    validate_usage(usage)
}

fn validate_usage(usage: &wire::ProviderUsage) -> Result<(), ProviderDataError> {
    if usage
        .cache_read_input_tokens
        .is_some_and(|cached| cached > usage.input_tokens)
    {
        return Err(ProviderDataError::UnexpectedPayload(
            "cached input exceeds provider input",
        ));
    }
    Ok(())
}

fn validate_terminal(value: &wire::ProviderTerminal) -> Result<(), ProviderDataError> {
    let classification = wire::ProviderTerminalClassification::try_from(value.classification)
        .map_err(|_| ProviderDataError::UnexpectedPayload("provider terminal is unknown"))?;
    if classification == wire::ProviderTerminalClassification::Unspecified
        || value.reason_code.is_empty()
        || value.completed_at_unix_ms <= 0
        || (value.response_message_count.is_some() && value.response_id.is_none())
        || value.response_id.as_ref().is_some_and(String::is_empty)
    {
        return Err(ProviderDataError::UnexpectedPayload(
            "provider terminal is incomplete",
        ));
    }
    if let Some(usage) = &value.final_usage {
        validate_usage(usage)?;
    }
    Ok(())
}
