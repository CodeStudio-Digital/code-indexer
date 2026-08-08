use agent_tools::capability::{CapabilityExecutionOutcome, CapabilityFailure, CapabilityOutput};
use serde_json::json;

use super::ProviderContextError;

pub(super) const SCHEMA_ID: &str = "codestudio.tool-result.v1";
pub(super) const SCHEMA_VERSION: u32 = 1;

type RenderedResult = (String, bool, bool, Option<u64>);

pub(super) fn render(
    outcome: &CapabilityExecutionOutcome,
) -> Result<RenderedResult, ProviderContextError> {
    match outcome {
        CapabilityExecutionOutcome::Succeeded(output) => successful_result(output),
        CapabilityExecutionOutcome::Failed(failure) => Ok(failure_result("failed", failure)),
        CapabilityExecutionOutcome::Cancelled(failure) => Ok(failure_result("cancelled", failure)),
        CapabilityExecutionOutcome::OutcomeUnknown(failure) => {
            Ok(failure_result("outcome_unknown", failure))
        }
    }
}

fn successful_result(output: &CapabilityOutput) -> Result<RenderedResult, ProviderContextError> {
    if output.schema_id != SCHEMA_ID || output.schema_version != SCHEMA_VERSION {
        return Ok((
            String::from_utf8(output.encoded_result.clone()).map_err(|_| {
                ProviderContextError::InvalidCapabilityResult("result is not UTF-8")
            })?,
            false,
            output.truncated,
            output.truncated.then_some(output.bytes_read),
        ));
    }
    let value: serde_json::Value = serde_json::from_slice(&output.encoded_result)
        .map_err(|_| ProviderContextError::InvalidCapabilityResult("host result is not JSON"))?;
    let object = value
        .as_object()
        .ok_or(ProviderContextError::InvalidCapabilityResult(
            "host result is not an object",
        ))?;
    let content = object
        .get("content")
        .and_then(serde_json::Value::as_str)
        .ok_or(ProviderContextError::InvalidCapabilityResult(
            "host result content is invalid",
        ))?;
    let is_error = object
        .get("isError")
        .and_then(serde_json::Value::as_bool)
        .ok_or(ProviderContextError::InvalidCapabilityResult(
            "host result error status is invalid",
        ))?;
    let transport = object
        .get("transport")
        .and_then(serde_json::Value::as_object)
        .ok_or(ProviderContextError::InvalidCapabilityResult(
            "host result transport is invalid",
        ))?;
    let truncated = transport
        .get("truncated")
        .and_then(serde_json::Value::as_bool)
        .ok_or(ProviderContextError::InvalidCapabilityResult(
            "host result truncation status is invalid",
        ))?;
    let original_bytes = transport
        .get("originalBytes")
        .and_then(serde_json::Value::as_u64)
        .ok_or(ProviderContextError::InvalidCapabilityResult(
            "host result byte count is invalid",
        ))?;
    if truncated != output.truncated || original_bytes != output.bytes_read {
        return Err(ProviderContextError::InvalidCapabilityResult(
            "host result transport conflicts with the execution envelope",
        ));
    }
    Ok((
        content.to_owned(),
        is_error,
        truncated,
        truncated.then_some(original_bytes),
    ))
}

fn failure_result(kind: &str, failure: &CapabilityFailure) -> RenderedResult {
    (
        json!({
            "error": {
                "kind": kind,
                "reason_code": failure.reason_code,
            }
        })
        .to_string(),
        true,
        false,
        None,
    )
}
