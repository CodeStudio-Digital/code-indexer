use std::collections::BTreeSet;

use prost::Message;
use zeroize::Zeroize;

use crate::bootstrap_limits::{
    BOOTSTRAP_SECRET_MIN_BYTES, LAUNCH_NONCE_MAX_BYTES, SESSION_TOKEN_MAX_BYTES,
};
use crate::generated::v1 as wire;
use crate::identity::ConnectionId;

use super::{
    SUPERVISOR_BOOTSTRAP_SCHEMA_VERSION, SupervisorBootstrapError,
    ValidatedSupervisorProcessHandoff,
};

const MAX_TEXT_BYTES: usize = 512;
const MAX_PATH_BYTES: usize = 32 * 1024;
const MAX_ENVIRONMENT_ENTRIES: usize = 8;

pub(super) fn decode(
    mut encoded: Vec<u8>,
    expected_host_process_id: u32,
    expected_supervisor_process_id: u32,
) -> Result<ValidatedSupervisorProcessHandoff, SupervisorBootstrapError> {
    let decoded = wire::SupervisorProcessHandoff::decode(encoded.as_slice())
        .map_err(crate::framing::FramingError::MalformedFrame);
    encoded.zeroize();
    let mut handoff = decoded?;
    if let Err(error) = validate(
        &handoff,
        expected_host_process_id,
        expected_supervisor_process_id,
    ) {
        handoff.management_session_token.zeroize();
        handoff.supervisor_launch_nonce.zeroize();
        return Err(error);
    }
    let connection_id = ConnectionId::new(handoff.management_connection_id.clone())
        .map_err(SupervisorBootstrapError::InvalidConnectionId)?;
    Ok(ValidatedSupervisorProcessHandoff {
        handoff,
        connection_id,
    })
}

fn validate(
    value: &wire::SupervisorProcessHandoff,
    expected_host_process_id: u32,
    expected_supervisor_process_id: u32,
) -> Result<(), SupervisorBootstrapError> {
    valid(
        value.schema_version == SUPERVISOR_BOOTSTRAP_SCHEMA_VERSION,
        "schema_version",
    )?;
    valid(
        value.host_process_id != 0 && value.host_process_id == expected_host_process_id,
        "host_process_id",
    )?;
    valid_text(
        &value.management_endpoint_address,
        "management_endpoint_address",
    )?;
    valid_secret(
        &value.management_session_token,
        SESSION_TOKEN_MAX_BYTES,
        "management_session_token",
    )?;
    valid_secret(
        &value.supervisor_launch_nonce,
        LAUNCH_NONCE_MAX_BYTES,
        "supervisor_launch_nonce",
    )?;
    validate_provenance(
        value.supervisor_provenance.as_ref(),
        Some(expected_supervisor_process_id),
        "supervisor_provenance",
    )?;
    validate_protocol_range(value.supported_protocols.as_ref())?;
    valid(value.containment.is_some(), "containment")?;
    valid_path(&value.runner_executable, "runner_executable")?;
    valid_path(&value.runner_working_directory, "runner_working_directory")?;
    if !value.lifecycle_outbox_directory.is_empty() {
        valid_path(
            &value.lifecycle_outbox_directory,
            "lifecycle_outbox_directory",
        )?;
    }
    validate_environment(&value.runner_environment)?;
    validate_expected_provenance(value.trusted_runner_provenance.as_ref())?;
    Ok(())
}

fn validate_protocol_range(
    value: Option<&wire::ProtocolVersionRange>,
) -> Result<(), SupervisorBootstrapError> {
    let value = value.ok_or(SupervisorBootstrapError::InvalidField(
        "supported_protocols",
    ))?;
    let minimum = value.minimum.ok_or(SupervisorBootstrapError::InvalidField(
        "supported_protocols.minimum",
    ))?;
    let maximum = value.maximum.ok_or(SupervisorBootstrapError::InvalidField(
        "supported_protocols.maximum",
    ))?;
    valid(
        minimum.major != 0
            && maximum.major != 0
            && (minimum.major, minimum.minor) <= (maximum.major, maximum.minor),
        "supported_protocols",
    )
}

fn validate_provenance(
    value: Option<&wire::RuntimeProvenance>,
    expected_process_id: Option<u32>,
    field: &'static str,
) -> Result<(), SupervisorBootstrapError> {
    let value = value.ok_or(SupervisorBootstrapError::InvalidField(field))?;
    valid_text(&value.build_id, field)?;
    valid_text(&value.source_commit, field)?;
    valid_text(&value.runtime_instance_id, field)?;
    valid_text(&value.operating_system, field)?;
    valid_text(&value.architecture, field)?;
    valid(value.binary_sha256.len() == 32, field)?;
    valid(
        value.pid != 0 && expected_process_id.is_none_or(|expected| value.pid == expected),
        field,
    )
}

fn validate_expected_provenance(
    value: Option<&wire::ExpectedRuntimeProvenance>,
) -> Result<(), SupervisorBootstrapError> {
    let value = value.ok_or(SupervisorBootstrapError::InvalidField(
        "trusted_runner_provenance",
    ))?;
    for text in [
        &value.build_id,
        &value.source_commit,
        &value.operating_system,
        &value.architecture,
    ] {
        valid_text(text, "trusted_runner_provenance")?;
    }
    valid(value.binary_sha256.len() == 32, "trusted_runner_provenance")
}

fn validate_environment(
    values: &[wire::SupervisorProcessEnvironmentEntry],
) -> Result<(), SupervisorBootstrapError> {
    valid(
        values.len() <= MAX_ENVIRONMENT_ENTRIES,
        "runner_environment",
    )?;
    let mut keys = BTreeSet::new();
    for entry in values {
        valid_text(&entry.key, "runner_environment.key")?;
        valid(
            entry.value.len() <= MAX_PATH_BYTES && !entry.value.contains('\0'),
            "runner_environment.value",
        )?;
        valid(
            keys.insert(entry.key.to_ascii_uppercase()),
            "runner_environment.key",
        )?;
    }
    Ok(())
}

fn valid_secret(
    value: &[u8],
    maximum: usize,
    field: &'static str,
) -> Result<(), SupervisorBootstrapError> {
    valid(
        (BOOTSTRAP_SECRET_MIN_BYTES..=maximum).contains(&value.len()),
        field,
    )
}

fn valid_text(value: &str, field: &'static str) -> Result<(), SupervisorBootstrapError> {
    valid(
        !value.trim().is_empty() && value.len() <= MAX_TEXT_BYTES && !value.contains('\0'),
        field,
    )
}

fn valid_path(value: &str, field: &'static str) -> Result<(), SupervisorBootstrapError> {
    valid(
        !value.trim().is_empty() && value.len() <= MAX_PATH_BYTES && !value.contains('\0'),
        field,
    )
}

const fn valid(condition: bool, field: &'static str) -> Result<(), SupervisorBootstrapError> {
    if condition {
        Ok(())
    } else {
        Err(SupervisorBootstrapError::InvalidField(field))
    }
}
