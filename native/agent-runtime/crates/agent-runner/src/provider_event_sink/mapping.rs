use agent_engine::ports::{EngineEvent, ProviderUsage, TerminalClassification, TerminalRecord};
use agent_protocol::generated::v1 as wire;
use agent_tools::capability::CapabilityExecutionOutcome;
use sha2::{Digest, Sha256};

use super::ProviderEventSinkError;

#[cfg(test)]
mod tests;

pub(super) fn event_body(
    event: EngineEvent<'_>,
) -> Result<wire::engine_event_record_v1::Body, ProviderEventSinkError> {
    use wire::engine_event_record_v1::Body;
    Ok(match event {
        EngineEvent::ProviderStarted { operation_id } => {
            Body::ProviderStarted(wire::EngineProviderStartedRecordV1 {
                operation_id: operation_id.to_owned(),
            })
        }
        EngineEvent::ProviderDelta { operation_id, text } => {
            Body::ProviderDelta(delta(operation_id, text, false)?)
        }
        EngineEvent::ProviderThinkingDelta { operation_id, text } => {
            Body::ProviderDelta(delta(operation_id, text, true)?)
        }
        EngineEvent::ProviderUsage {
            operation_id,
            usage,
        } => Body::ProviderUsage(wire::EngineProviderUsageRecordV1 {
            operation_id: operation_id.to_owned(),
            usage: Some(usage_to_wire(usage)),
        }),
        EngineEvent::ProviderCompleted {
            operation_id,
            response_id,
        } => Body::ProviderCompleted(wire::EngineProviderCompletedRecordV1 {
            operation_id: operation_id.to_owned(),
            response_id: response_id.map(str::to_owned),
        }),
        EngineEvent::CapabilityBoundary {
            operation_id,
            tool_use_id,
            call,
        } => Body::CapabilityBoundary(wire::EngineCapabilityBoundaryRecordV1 {
            operation_id: operation_id.to_owned(),
            tool_use_id: tool_use_id.to_owned(),
            capability_name: call.capability_name.clone(),
            capability_id: call.capability_id.clone(),
            input_sha256: call.arguments_sha256.to_vec(),
        }),
        EngineEvent::CapabilityDispatchStarted {
            operation_id,
            tool_use_id,
            grant_id,
            effective_input_sha256,
            started_at_unix_ms,
        } => Body::CapabilityDispatchStarted(wire::EngineCapabilityDispatchStartedRecordV1 {
            operation_id: operation_id.to_owned(),
            tool_use_id: tool_use_id.to_owned(),
            grant_id: grant_id.to_owned(),
            effective_input_sha256: effective_input_sha256.to_vec(),
            started_at_unix_ms,
        }),
        EngineEvent::CapabilityRefused {
            operation_id,
            tool_use_id,
            rejection,
        } => Body::CapabilityRefused(wire::EngineCapabilityRefusedRecordV1 {
            operation_id: operation_id.to_owned(),
            tool_use_id: tool_use_id.to_owned(),
            decision_id: rejection.decision_id.clone(),
            reason_code: rejection.reason_code.clone(),
            policy_version: rejection.policy_version.clone(),
            decided_at_unix_ms: rejection.decided_at_unix_ms,
        }),
        EngineEvent::CapabilityTerminal {
            operation_id,
            tool_use_id,
            grant_id,
            outcome,
            completed_at_unix_ms,
        } => Body::CapabilityTerminal(capability_terminal(
            operation_id,
            tool_use_id,
            grant_id,
            outcome,
            completed_at_unix_ms,
        )?),
    })
}

fn capability_terminal(
    operation_id: &str,
    tool_use_id: &str,
    grant_id: &str,
    outcome: &CapabilityExecutionOutcome,
    completed_at_unix_ms: i64,
) -> Result<wire::EngineCapabilityTerminalRecordV1, ProviderEventSinkError> {
    use wire::EngineCapabilityTerminalClassificationV1 as Classification;
    let (
        classification,
        reason_code,
        schema_id,
        schema_version,
        digest,
        result_bytes,
        bytes_read,
        bytes_emitted,
        truncated,
        duration_ms,
    ) = match outcome {
        CapabilityExecutionOutcome::Succeeded(output) => (
            Classification::Succeeded,
            "succeeded",
            output.schema_id.as_str(),
            output.schema_version,
            output.result_sha256.to_vec(),
            u64::try_from(output.encoded_result.len())
                .map_err(|_| ProviderEventSinkError::SequenceExhausted)?,
            output.bytes_read,
            output.bytes_emitted,
            output.truncated,
            output.duration_ms,
        ),
        CapabilityExecutionOutcome::Failed(failure) => failure_terminal(
            Classification::Failed,
            failure.reason_code.as_str(),
            failure.duration_ms,
        ),
        CapabilityExecutionOutcome::Cancelled(failure) => failure_terminal(
            Classification::Cancelled,
            failure.reason_code.as_str(),
            failure.duration_ms,
        ),
        CapabilityExecutionOutcome::OutcomeUnknown(failure) => failure_terminal(
            Classification::OutcomeUnknown,
            failure.reason_code.as_str(),
            failure.duration_ms,
        ),
    };
    if reason_code.is_empty() || reason_code.len() > 1_024 || reason_code.contains('\0') {
        return Err(ProviderEventSinkError::InvalidAuthority("reason_code"));
    }
    Ok(wire::EngineCapabilityTerminalRecordV1 {
        operation_id: operation_id.to_owned(),
        tool_use_id: tool_use_id.to_owned(),
        grant_id: grant_id.to_owned(),
        classification: classification as i32,
        reason_code: reason_code.to_owned(),
        result_schema_id: schema_id.to_owned(),
        result_schema_version: schema_version,
        result_sha256: digest,
        result_bytes,
        bytes_read,
        bytes_emitted,
        truncated,
        duration_ms,
        completed_at_unix_ms,
    })
}

type TerminalFields<'a> = (
    wire::EngineCapabilityTerminalClassificationV1,
    &'a str,
    &'static str,
    u32,
    Vec<u8>,
    u64,
    u64,
    u64,
    bool,
    u64,
);

const fn failure_terminal(
    classification: wire::EngineCapabilityTerminalClassificationV1,
    reason_code: &str,
    duration_ms: u64,
) -> TerminalFields<'_> {
    (
        classification,
        reason_code,
        "",
        0,
        Vec::new(),
        0,
        0,
        0,
        false,
        duration_ms,
    )
}

pub(super) fn terminal_body(
    terminal: TerminalRecord<'_>,
) -> Result<wire::engine_event_record_v1::Body, ProviderEventSinkError> {
    if terminal.reason_code.trim().is_empty()
        || terminal.reason_code.len() > 1_024
        || terminal.reason_code.contains('\0')
    {
        return Err(ProviderEventSinkError::InvalidAuthority("reason_code"));
    }
    let classification = match terminal.classification {
        TerminalClassification::Completed => wire::EngineTerminalClassificationV1::Completed,
        TerminalClassification::Failed => wire::EngineTerminalClassificationV1::Failed,
        TerminalClassification::Interrupted => wire::EngineTerminalClassificationV1::Interrupted,
    };
    Ok(wire::engine_event_record_v1::Body::Terminal(
        wire::EngineTerminalRecordV1 {
            classification: classification.into(),
            reason_code: terminal.reason_code.to_owned(),
            usage: terminal.usage.map(usage_to_wire),
        },
    ))
}

fn delta(
    operation_id: &str,
    text: &str,
    thinking: bool,
) -> Result<wire::EngineProviderDeltaRecordV1, ProviderEventSinkError> {
    let utf8_bytes =
        u64::try_from(text.len()).map_err(|_| ProviderEventSinkError::SequenceExhausted)?;
    Ok(wire::EngineProviderDeltaRecordV1 {
        operation_id: operation_id.to_owned(),
        utf8_bytes,
        content_sha256: Sha256::digest(text.as_bytes()).to_vec(),
        thinking,
    })
}

const fn usage_to_wire(usage: ProviderUsage) -> wire::EngineUsageSnapshotV1 {
    wire::EngineUsageSnapshotV1 {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cached_input_tokens: usage.cached_input_tokens,
        cost_micros: usage.cost_micros,
    }
}
