use std::collections::BTreeMap;
use std::fmt::Write;

use agent_engine::operation::OperationId;
use agent_engine::ports::{ProviderEvent, ProviderToolCall, ProviderUsage};
use agent_protocol::generated::v1 as wire;
use prost::Message;
use sha2::{Digest, Sha256};

use super::ProviderGatewayError;
use crate::provider_data::ProviderWireEvent;

pub(super) struct MappedProviderEvent {
    pub event: ProviderEvent,
    pub buffered: Option<ProviderEvent>,
    pub terminal_delivered: bool,
}

pub(super) fn idempotency_key(identity: &wire::AttemptIdentity, operation_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(identity.encode_to_vec());
    hasher.update([0]);
    hasher.update(operation_id.as_bytes());
    let mut key = String::with_capacity(79);
    key.push_str("provider-start/");
    for byte in hasher.finalize() {
        write!(&mut key, "{byte:02x}").expect("writing to String cannot fail");
    }
    key
}

pub(super) fn map_wire_event(
    event: ProviderWireEvent,
    operation_id: &OperationId,
    tools: &BTreeMap<String, wire::ProviderToolDescriptor>,
) -> Result<MappedProviderEvent, ProviderGatewayError> {
    let plain = |event| MappedProviderEvent {
        event,
        buffered: None,
        terminal_delivered: false,
    };
    Ok(match event {
        ProviderWireEvent::Text(value) => plain(ProviderEvent::TextDelta(value.text)),
        ProviderWireEvent::Thinking(value) => plain(ProviderEvent::ThinkingDelta(value.text)),
        ProviderWireEvent::Usage(value) => plain(ProviderEvent::Usage(map_usage(
            value
                .usage
                .as_ref()
                .ok_or(ProviderGatewayError::InvalidProviderEvent(
                    "usage is missing",
                ))?,
        ))),
        ProviderWireEvent::ToolCall(value) => {
            let event_operation = OperationId::new(value.operation_id)
                .map_err(|_| ProviderGatewayError::InvalidProviderEvent("operation ID"))?;
            if event_operation != *operation_id {
                return Err(ProviderGatewayError::InvalidProviderEvent(
                    "operation authority mismatch",
                ));
            }
            let descriptor = tools.get(value.capability_name.as_str()).ok_or(
                ProviderGatewayError::InvalidProviderEvent("unknown capability"),
            )?;
            let execution_class = execution_class(descriptor.execution_class)?;
            let arguments_sha256 = value
                .arguments_sha256
                .as_slice()
                .try_into()
                .map_err(|_| ProviderGatewayError::InvalidProviderEvent("arguments digest"))?;
            plain(ProviderEvent::ToolCall(ProviderToolCall {
                operation_id: event_operation,
                tool_use_id: OperationId::new(value.tool_use_id)
                    .map_err(|_| ProviderGatewayError::InvalidProviderEvent("tool use ID"))?,
                capability_name: value.capability_name,
                capability_id: descriptor.capability_id.clone(),
                capability_version: descriptor.capability_version.clone(),
                execution_class,
                mutates: descriptor.mutates,
                encoded_arguments: value.encoded_json_arguments,
                arguments_sha256,
                provider_response_id: None,
                provider_response_message_count: None,
            }))
        }
        ProviderWireEvent::Terminal(value) => map_terminal(value)?,
    })
}

fn execution_class(
    value: i32,
) -> Result<agent_tools::capability::ExecutionClass, ProviderGatewayError> {
    use agent_tools::capability::ExecutionClass;
    Ok(
        match wire::CapabilityExecutionClass::try_from(value)
            .map_err(|_| ProviderGatewayError::InvalidProviderEvent("capability execution class"))?
        {
            wire::CapabilityExecutionClass::NativeRead => ExecutionClass::NativeRead,
            wire::CapabilityExecutionClass::NativeMutation => ExecutionClass::NativeMutation,
            wire::CapabilityExecutionClass::NativeProcess => ExecutionClass::NativeProcess,
            wire::CapabilityExecutionClass::HostCapability => ExecutionClass::HostCapability,
            wire::CapabilityExecutionClass::ControlInteractive => {
                ExecutionClass::ControlInteractive
            }
            wire::CapabilityExecutionClass::NestedCode => ExecutionClass::NestedCode,
            wire::CapabilityExecutionClass::RemoteEnvironment => ExecutionClass::RemoteEnvironment,
            wire::CapabilityExecutionClass::Unspecified => {
                return Err(ProviderGatewayError::InvalidProviderEvent(
                    "unspecified capability execution class",
                ));
            }
        },
    )
}

fn map_terminal(
    value: wire::ProviderTerminal,
) -> Result<MappedProviderEvent, ProviderGatewayError> {
    let classification = wire::ProviderTerminalClassification::try_from(value.classification)
        .map_err(|_| ProviderGatewayError::InvalidProviderEvent("terminal classification"))?;
    let terminal =
        match classification {
            wire::ProviderTerminalClassification::Completed => ProviderEvent::Completed {
                response_id: value.response_id.ok_or(
                    ProviderGatewayError::InvalidProviderEvent("completed response ID"),
                )?,
                response_message_count: value.response_message_count,
            },
            wire::ProviderTerminalClassification::Failed => ProviderEvent::Failed {
                reason_code: value.reason_code,
            },
            wire::ProviderTerminalClassification::Cancelled => ProviderEvent::Interrupted {
                reason_code: value.reason_code,
            },
            wire::ProviderTerminalClassification::Unspecified => {
                return Err(ProviderGatewayError::InvalidProviderEvent(
                    "unspecified terminal classification",
                ));
            }
        };
    if let Some(usage) = value.final_usage.as_ref() {
        Ok(MappedProviderEvent {
            event: ProviderEvent::Usage(map_usage(usage)),
            buffered: Some(terminal),
            terminal_delivered: false,
        })
    } else {
        Ok(MappedProviderEvent {
            event: terminal,
            buffered: None,
            terminal_delivered: true,
        })
    }
}

fn map_usage(value: &wire::ProviderUsage) -> ProviderUsage {
    ProviderUsage {
        input_tokens: value.input_tokens,
        output_tokens: value.output_tokens,
        cached_input_tokens: value.cache_read_input_tokens.unwrap_or(0),
        cost_micros: value.cost_micros.unwrap_or(0),
    }
}
