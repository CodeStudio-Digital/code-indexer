use crate::generated::v1 as wire;
use crate::identity::ConnectionId;
use crate::version::ProtocolVersion;

use crate::management_channel::{ManagementChannelError, management_hard_cap};

mod compatibility;
mod model;
mod secret;

use compatibility::{
    parse_version, provenance_matches, validate_containment, validate_protocol_range,
    validate_required_containment,
};
pub use model::ManagementSessionPolicy;
pub(in crate::management_channel) use secret::{SecretDigest, seal_nonce, seal_token};

const MAX_POLICY_TEXT_BYTES: usize = 512;
const MAX_ALLOWED_RUNNER_BUILDS: usize = 256;
const MAX_ACTIVE_ATTEMPTS: u32 = 4_096;
const MAX_PENDING_LAUNCHES: u32 = 4_096;
const MAX_RESERVED_MEMORY_BYTES: u64 = 1 << 50;
const MAX_RESERVED_PROCESSES: u32 = 65_536;
const MAX_TIMER_MS: u64 = 60 * 60 * 1_000;
const MAX_IN_FLIGHT_FRAMES: u64 = 1_024;
const MAX_IN_FLIGHT_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone)]
pub(in crate::management_channel) struct BootstrapSelection {
    pub protocol: ProtocolVersion,
    pub maximum_frame_bytes: usize,
    pub policy: ManagementSessionPolicy,
}

pub(in crate::management_channel) fn validate_host_hello(
    hello: &wire::HostSupervisorHello,
    expected_connection: &ConnectionId,
    expected_token: SecretDigest,
) -> Result<BootstrapSelection, ManagementChannelError> {
    let selected = hello
        .selected_protocol
        .as_ref()
        .ok_or(ManagementChannelError::MissingSelectedProtocol)?;
    let protocol = parse_version(*selected)?;
    if hello.connection_id != expected_connection.as_str() {
        return Err(ManagementChannelError::ConnectionMismatch);
    }
    if validate_text(&hello.contract_version, "contract_version").is_err() {
        return Err(ManagementChannelError::InvalidContract);
    }
    if hello.contract_schema_version == 0 {
        return Err(ManagementChannelError::InvalidContract);
    }
    validate_expected_provenance(
        hello
            .expected_supervisor_provenance
            .as_ref()
            .ok_or(ManagementChannelError::MissingSupervisorProvenance)?,
    )?;
    if hello.allowed_runner_provenance.is_empty()
        || hello.allowed_runner_provenance.len() > MAX_ALLOWED_RUNNER_BUILDS
    {
        return Err(ManagementChannelError::InvalidProvenance(
            "allowed_runner_provenance",
        ));
    }
    for provenance in &hello.allowed_runner_provenance {
        validate_expected_provenance(provenance)?;
    }
    validate_supervisor_limits(
        hello
            .limits
            .as_ref()
            .ok_or(ManagementChannelError::MissingSupervisorLimits)?,
    )?;
    let maximum_frame_bytes = validate_frame_limits(
        hello
            .frame_limits
            .as_ref()
            .ok_or(ManagementChannelError::MissingFrameLimits)?,
    )?;
    if !expected_token.matches_token(&hello.management_session_token) {
        return Err(ManagementChannelError::InvalidManagementToken);
    }
    let containment = validate_required_containment(hello.required_containment_level)?;
    Ok(BootstrapSelection {
        protocol,
        maximum_frame_bytes,
        policy: ManagementSessionPolicy::new(hello, expected_token, containment),
    })
}

pub(in crate::management_channel) fn validate_supervisor_hello(
    hello: &wire::SupervisorHello,
    selected: &BootstrapSelection,
    expected_launch_nonce: SecretDigest,
) -> Result<(), ManagementChannelError> {
    validate_protocol_range(hello, selected.protocol)?;
    if hello.contract_version != selected.policy.contract_version()
        || hello.contract_schema_version != selected.policy.contract_schema_version()
    {
        return Err(ManagementChannelError::SupervisorContractMismatch);
    }
    let actual = hello
        .provenance
        .as_ref()
        .ok_or(ManagementChannelError::MissingSupervisorProvenance)?;
    validate_runtime_provenance(actual)?;
    let expected = selected.policy.expected_supervisor_provenance();
    if !provenance_matches(expected, actual) {
        return Err(ManagementChannelError::SupervisorProvenanceMismatch);
    }
    if !expected_launch_nonce.matches_nonce(&hello.launch_nonce) {
        return Err(ManagementChannelError::SupervisorNonceMismatch);
    }
    if selected.policy.allowed_feature_bits() & !hello.supported_feature_bits != 0 {
        return Err(ManagementChannelError::InvalidFeatureNegotiation);
    }
    validate_containment(
        selected.policy.required_containment_level(),
        *hello
            .containment
            .as_ref()
            .ok_or(ManagementChannelError::InsufficientContainment)?,
    )
}

fn validate_supervisor_limits(
    limits: &wire::SupervisorLimits,
) -> Result<(), ManagementChannelError> {
    let valid = (1..=MAX_ACTIVE_ATTEMPTS).contains(&limits.max_active_attempts)
        && (1..=MAX_PENDING_LAUNCHES).contains(&limits.max_pending_launches)
        && (1..=MAX_RESERVED_MEMORY_BYTES).contains(&limits.max_reserved_memory_bytes)
        && (limits.max_active_attempts..=MAX_RESERVED_PROCESSES)
            .contains(&limits.max_reserved_processes)
        && (1..=MAX_TIMER_MS).contains(&limits.host_disconnect_grace_ms)
        && (1..=MAX_TIMER_MS).contains(&limits.runner_pulse_timeout_ms);
    if !valid {
        return Err(ManagementChannelError::InvalidSupervisorLimits);
    }
    Ok(())
}

fn validate_frame_limits(limits: &wire::FrameLimits) -> Result<usize, ManagementChannelError> {
    let maximum = usize::try_from(limits.max_frame_bytes)
        .map_err(|_| ManagementChannelError::InvalidFrameLimits)?;
    let valid = maximum > 0
        && maximum <= management_hard_cap()
        && limits.max_chunk_bytes > 0
        && limits.max_chunk_bytes <= limits.max_frame_bytes
        && (1..=MAX_IN_FLIGHT_FRAMES).contains(&limits.max_in_flight_frames)
        && limits.max_in_flight_bytes >= limits.max_frame_bytes
        && limits.max_in_flight_bytes <= MAX_IN_FLIGHT_BYTES
        && (1..=MAX_TIMER_MS).contains(&limits.read_timeout_ms)
        && (1..=MAX_TIMER_MS).contains(&limits.write_timeout_ms)
        && !limits.transport_crc32c;
    if !valid {
        return Err(ManagementChannelError::InvalidFrameLimits);
    }
    Ok(maximum)
}

fn validate_expected_provenance(
    value: &wire::ExpectedRuntimeProvenance,
) -> Result<(), ManagementChannelError> {
    validate_text(&value.build_id, "build_id")?;
    validate_text(&value.source_commit, "source_commit")?;
    validate_text(&value.operating_system, "operating_system")?;
    validate_text(&value.architecture, "architecture")?;
    if value.binary_sha256.len() != 32 {
        return Err(ManagementChannelError::InvalidProvenance("binary_sha256"));
    }
    Ok(())
}

fn validate_runtime_provenance(
    value: &wire::RuntimeProvenance,
) -> Result<(), ManagementChannelError> {
    validate_text(&value.build_id, "build_id")?;
    validate_text(&value.source_commit, "source_commit")?;
    validate_text(&value.runtime_instance_id, "runtime_instance_id")?;
    validate_text(&value.operating_system, "operating_system")?;
    validate_text(&value.architecture, "architecture")?;
    if value.binary_sha256.len() != 32 || value.pid == 0 {
        return Err(ManagementChannelError::InvalidProvenance(
            "binary_sha256_or_pid",
        ));
    }
    Ok(())
}

fn validate_text(value: &str, field: &'static str) -> Result<(), ManagementChannelError> {
    if value.trim().is_empty()
        || value.len() > MAX_POLICY_TEXT_BYTES
        || value.as_bytes().contains(&0)
    {
        return Err(ManagementChannelError::InvalidProvenance(field));
    }
    Ok(())
}
