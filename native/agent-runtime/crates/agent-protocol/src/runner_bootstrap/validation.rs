use crate::activation_authority::ActivationAuthoritySeal;
use crate::bootstrap_limits::{BOOTSTRAP_SECRET_MIN_BYTES, LAUNCH_NONCE_MAX_BYTES};
use crate::generated::v1 as wire;
use crate::wire_identity::{identity_from_wire, validate_required_identifier};

use super::RunnerBootstrapError;
use super::error::invalid;

mod endpoints;
mod resources;

const HANDOFF: &str = "RunnerLaunchHandoff";
const SHA256_BYTES: usize = 32;

pub(super) fn validate_handoff(
    value: &wire::RunnerLaunchHandoff,
) -> Result<(), RunnerBootstrapError> {
    if value.schema_version != super::RUNNER_BOOTSTRAP_SCHEMA_VERSION {
        return Err(invalid(HANDOFF, "schema_version"));
    }
    let identity = value
        .identity
        .as_ref()
        .ok_or_else(|| invalid(HANDOFF, "identity"))?;
    identity_from_wire(identity).map_err(RunnerBootstrapError::InvalidIdentity)?;
    validate_required_identifier(&value.runtime_instance_id, "runtime_instance_id")
        .map_err(RunnerBootstrapError::InvalidIdentity)?;
    if value.runner_process_id == 0 {
        return Err(invalid(HANDOFF, "runner_process_id"));
    }
    if value.hard_deadline_at_unix_ms <= 0 {
        return Err(invalid(HANDOFF, "hard_deadline_at_unix_ms"));
    }
    if !(BOOTSTRAP_SECRET_MIN_BYTES..=LAUNCH_NONCE_MAX_BYTES).contains(&value.launch_nonce.len()) {
        return Err(invalid(HANDOFF, "launch_nonce"));
    }
    if value.launch_management_payload_sha256.len() != SHA256_BYTES {
        return Err(invalid(HANDOFF, "launch_management_payload_sha256"));
    }
    let activation_authority = value
        .activation_authority_seal
        .as_ref()
        .ok_or_else(|| invalid(HANDOFF, "activation_authority_seal"))?;
    ActivationAuthoritySeal::try_from(activation_authority)
        .map_err(|_| invalid(HANDOFF, "activation_authority_seal"))?;
    validate_runtime_provenance(value)?;
    resources::validate_budget(value.reserved_resource_budget.as_ref())?;
    resources::validate_containment(value.effective_containment.as_ref())?;
    endpoints::validate_endpoints_and_peers(value)
}

fn validate_runtime_provenance(
    handoff: &wire::RunnerLaunchHandoff,
) -> Result<(), RunnerBootstrapError> {
    let provenance = handoff
        .runtime_provenance
        .as_ref()
        .ok_or_else(|| invalid(HANDOFF, "runtime_provenance"))?;
    if !valid_text(&provenance.build_id)
        || !valid_text(&provenance.source_commit)
        || !valid_text(&provenance.operating_system)
        || !valid_text(&provenance.architecture)
        || provenance.binary_sha256.len() != SHA256_BYTES
        || provenance.runtime_instance_id != handoff.runtime_instance_id
        || provenance.pid != handoff.runner_process_id
    {
        return Err(invalid(HANDOFF, "runtime_provenance"));
    }
    Ok(())
}

pub(super) fn validate_ready(
    actual: &wire::RunnerEndpointsReady,
    expected: &wire::RunnerEndpointsReady,
) -> Result<(), RunnerBootstrapError> {
    if actual.acknowledged_handoff_sha256.len() != SHA256_BYTES
        || !constant_time_equal(
            &actual.acknowledged_handoff_sha256,
            &expected.acknowledged_handoff_sha256,
        )
    {
        return Err(RunnerBootstrapError::ReadyMismatch(
            "acknowledged_handoff_sha256",
        ));
    }
    if actual.schema_version != expected.schema_version {
        return Err(RunnerBootstrapError::ReadyMismatch("schema_version"));
    }
    if actual.identity != expected.identity {
        return Err(RunnerBootstrapError::ReadyMismatch("identity"));
    }
    if actual.runtime_instance_id != expected.runtime_instance_id {
        return Err(RunnerBootstrapError::ReadyMismatch("runtime_instance_id"));
    }
    if actual.runner_process_id != expected.runner_process_id {
        return Err(RunnerBootstrapError::ReadyMismatch("runner_process_id"));
    }
    if actual.endpoints != expected.endpoints {
        return Err(RunnerBootstrapError::ReadyMismatch("endpoints"));
    }
    Ok(())
}

pub(super) fn valid_text(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 512 && !value.as_bytes().contains(&0)
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0_u8, |difference, (left, right)| {
                difference | (left ^ right)
            })
            == 0
}
