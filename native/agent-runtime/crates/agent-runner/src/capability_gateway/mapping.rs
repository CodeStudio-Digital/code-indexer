use agent_protocol::generated::v1 as wire;
use agent_tools::capability::{
    CapabilityApproval, CapabilityDecision, CapabilityExecutionOutcome, CapabilityFailure,
    CapabilityInvocation, CapabilityOutput, CapabilityRejection, ExecutionClass,
    NativeFilesystemReadBinding, SealedExecutionGrant,
};
use sha2::{Digest, Sha256};
use wire::capability_execution_result::Outcome;

use super::CapabilityGatewayError;

#[cfg(test)]
mod tests;

const MAX_RESULT_IDENTIFIER_BYTES: usize = 1_024;
const MAX_EXECUTION_DURATION_MS: u64 = 24 * 60 * 60 * 1_000;

pub(super) const fn execution_class_to_wire(
    value: ExecutionClass,
) -> wire::CapabilityExecutionClass {
    match value {
        ExecutionClass::NativeRead => wire::CapabilityExecutionClass::NativeRead,
        ExecutionClass::NativeMutation => wire::CapabilityExecutionClass::NativeMutation,
        ExecutionClass::NativeProcess => wire::CapabilityExecutionClass::NativeProcess,
        ExecutionClass::HostCapability => wire::CapabilityExecutionClass::HostCapability,
        ExecutionClass::ControlInteractive => wire::CapabilityExecutionClass::ControlInteractive,
        ExecutionClass::NestedCode => wire::CapabilityExecutionClass::NestedCode,
        ExecutionClass::RemoteEnvironment => wire::CapabilityExecutionClass::RemoteEnvironment,
    }
}

pub(super) fn decision_from_wire(
    update: wire::CapabilityUpdate,
    invocation: &CapabilityInvocation,
) -> Result<CapabilityDecision, CapabilityGatewayError> {
    use wire::capability_update::Decision;
    Ok(match update.decision {
        Some(Decision::Rejected(value)) => CapabilityDecision::Rejected(CapabilityRejection {
            decision_id: value.decision_id,
            reason_code: value.reason_code,
            policy_version: value.policy_version,
            decided_at_unix_ms: value.decided_at_unix_ms,
        }),
        Some(Decision::ApprovalRequired(value)) => {
            CapabilityDecision::ApprovalRequired(CapabilityApproval {
                decision_id: value.decision_id,
                interaction_id: value.interaction_id,
                reason_code: value.reason_code,
                policy_version: value.policy_version,
                decided_at_unix_ms: value.decided_at_unix_ms,
            })
        }
        Some(Decision::Accepted(value)) => {
            let expected_input_sha256 = invocation.input_sha256;
            if value.capability_id != invocation.capability_id
                || value.capability_version != invocation.capability_version
                || value.operation_id != invocation.operation_id
                || value.tool_use_id != invocation.tool_use_id
                || value.effective_input_sha256 != expected_input_sha256
                || value.execution_class
                    != execution_class_to_wire(invocation.execution_class) as i32
                || value.mutates != invocation.mutates
            {
                return Err(CapabilityGatewayError::ContradictoryDecision("invocation"));
            }
            CapabilityDecision::Accepted(Box::new(grant_from_wire(value)?))
        }
        None => return Err(CapabilityGatewayError::ContradictoryDecision("decision")),
    })
}

fn grant_from_wire(
    value: wire::SealedExecutionGrant,
) -> Result<SealedExecutionGrant, CapabilityGatewayError> {
    Ok(SealedExecutionGrant {
        grant_id: value.grant_id,
        decision_id: value.decision_id,
        capability_id: value.capability_id,
        capability_version: value.capability_version,
        operation_id: value.operation_id,
        tool_use_id: value.tool_use_id,
        effective_input_sha256: digest(value.effective_input_sha256)?,
        execution_class: execution_class_from_wire(value.execution_class)?,
        mutates: value.mutates,
        environment_id: value.environment_id,
        environment_version: value.environment_version,
        workspace_lease_id: value.workspace_lease_id,
        workspace_lease_version: value.workspace_lease_version,
        workspace_fencing_epoch: value.workspace_fencing_epoch,
        resource_binding_id: value.resource_binding_id,
        constraints_sha256: digest(value.constraints_sha256)?,
        policy_version: value.policy_version,
        nonce: value.nonce,
        issued_at_unix_ms: value.issued_at_unix_ms,
        expires_at_unix_ms: value.expires_at_unix_ms,
        native_filesystem_read: value.native_filesystem_read.map(|binding| {
            NativeFilesystemReadBinding {
                canonical_root_path: binding.canonical_root_path,
                max_read_bytes: binding.max_read_bytes,
                max_output_bytes: binding.max_output_bytes,
                require_utf8: binding.require_utf8,
            }
        }),
    })
}

fn digest(value: Vec<u8>) -> Result<[u8; 32], CapabilityGatewayError> {
    value
        .try_into()
        .map_err(|_| CapabilityGatewayError::ContradictoryDecision("digest"))
}

fn execution_class_from_wire(value: i32) -> Result<ExecutionClass, CapabilityGatewayError> {
    Ok(
        match wire::CapabilityExecutionClass::try_from(value)
            .map_err(|_| CapabilityGatewayError::ContradictoryDecision("execution class"))?
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
                return Err(CapabilityGatewayError::ContradictoryDecision(
                    "execution class",
                ));
            }
        },
    )
}

pub(super) fn outcome_from_wire(
    result: wire::CapabilityExecutionResult,
    invocation: &CapabilityInvocation,
    grant: &SealedExecutionGrant,
    maximum_output_bytes: usize,
) -> Result<CapabilityExecutionOutcome, CapabilityGatewayError> {
    if result.operation_id != invocation.operation_id
        || result.tool_use_id != invocation.tool_use_id
        || result.grant_id != grant.grant_id
    {
        return Err(CapabilityGatewayError::ContradictoryDecision("execution"));
    }
    match result.outcome {
        Some(Outcome::Succeeded(value)) => {
            if !bounded_identifier(&value.schema_id)
                || value.schema_version == 0
                || value.encoded_result.is_empty()
                || value.encoded_result.len() > maximum_output_bytes
                || value.result_sha256.len() != 32
                || Sha256::digest(&value.encoded_result).as_slice() != value.result_sha256
                || value.bytes_emitted
                    != u64::try_from(value.encoded_result.len()).unwrap_or(u64::MAX)
                || value.duration_ms > MAX_EXECUTION_DURATION_MS
            {
                return Err(CapabilityGatewayError::ContradictoryDecision(
                    "execution result",
                ));
            }
            let result_sha256 = value
                .result_sha256
                .try_into()
                .map_err(|_| CapabilityGatewayError::ContradictoryDecision("result digest"))?;
            Ok(CapabilityExecutionOutcome::Succeeded(CapabilityOutput {
                schema_id: value.schema_id,
                schema_version: value.schema_version,
                encoded_result: value.encoded_result,
                result_sha256,
                bytes_read: value.bytes_read,
                bytes_emitted: value.bytes_emitted,
                truncated: value.truncated,
                duration_ms: value.duration_ms,
            }))
        }
        Some(Outcome::Failed(value)) => Ok(CapabilityExecutionOutcome::Failed(failure(value)?)),
        Some(Outcome::Cancelled(value)) => {
            Ok(CapabilityExecutionOutcome::Cancelled(failure(value)?))
        }
        Some(Outcome::OutcomeUnknown(value)) => {
            Ok(CapabilityExecutionOutcome::OutcomeUnknown(failure(value)?))
        }
        None => Err(CapabilityGatewayError::ContradictoryDecision(
            "execution outcome",
        )),
    }
}

fn failure(
    value: wire::CapabilityExecutionFailure,
) -> Result<CapabilityFailure, CapabilityGatewayError> {
    if !bounded_identifier(&value.reason_code) || value.duration_ms > MAX_EXECUTION_DURATION_MS {
        return Err(CapabilityGatewayError::ContradictoryDecision(
            "execution failure",
        ));
    }
    Ok(CapabilityFailure {
        reason_code: value.reason_code,
        duration_ms: value.duration_ms,
    })
}

fn bounded_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_RESULT_IDENTIFIER_BYTES && !value.contains('\0')
}
