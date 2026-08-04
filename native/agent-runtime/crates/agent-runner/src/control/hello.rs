use agent_protocol::bootstrap_limits::{BOOTSTRAP_SECRET_MIN_BYTES, SESSION_TOKEN_MAX_BYTES};
use agent_protocol::generated::v1 as wire;
use agent_protocol::identity::ConnectionId;
use agent_protocol::version::{FeatureSet, NegotiatedProtocol, ProtocolRange, ProtocolVersion};

use super::effective::capabilities_support;
use super::error::ControlError;
use super::launch::RunnerLaunchContext;

mod limits;
mod native;

use limits::validate_frame_limits;
use native::validate_native_capabilities;

pub(super) const SUPPORTED_SPEC_SCHEMA_VERSION: u32 = 1;
const MAX_HELLO_TEXT_BYTES: usize = 512;

#[derive(Debug)]
pub(super) struct AgentHelloContext {
    pub versions: ProtocolRange,
    pub contract_version: String,
    pub supported_features: FeatureSet,
}

#[derive(Debug)]
pub(super) struct ConnectionContext {
    pub connection_id: ConnectionId,
    pub negotiated: NegotiatedProtocol,
    pub max_frame_bytes: usize,
    #[allow(
        dead_code,
        reason = "consumed only by the internal async driver before the Host control pump"
    )]
    pub read_timeout_ms: u64,
    pub write_timeout_ms: u64,
    pub heartbeat_interval_ms: u64,
}

pub(super) fn validate_agent_hello_draft(
    hello: &wire::AgentHello,
    launch: &RunnerLaunchContext,
) -> Result<AgentHelloContext, ControlError> {
    if !hello.launch_nonce.is_empty() {
        return Err(ControlError::InvalidAgentHello(
            "AgentHello draft already contains a launch nonce",
        ));
    }
    validate_agent_hello_metadata(hello, launch)
}

fn validate_agent_hello_metadata(
    hello: &wire::AgentHello,
    launch: &RunnerLaunchContext,
) -> Result<AgentHelloContext, ControlError> {
    let versions = protocol_range(hello.supported_protocols.as_ref().ok_or(
        ControlError::InvalidAgentHello("supported protocol range is missing"),
    )?)?;
    validate_text(&hello.contract_version).map_err(ControlError::InvalidAgentHello)?;
    if hello.contract_schema_version != SUPPORTED_SPEC_SCHEMA_VERSION {
        return Err(ControlError::InvalidAgentHello(
            "contract schema version is unsupported",
        ));
    }
    let provenance = hello
        .provenance
        .as_ref()
        .ok_or(ControlError::InvalidAgentHello("provenance is missing"))?;
    validate_provenance(provenance, launch)?;
    let capabilities = hello
        .containment
        .as_ref()
        .ok_or(ControlError::InvalidAgentHello(
            "containment capabilities are missing",
        ))?;
    capabilities_support(*capabilities, launch.required_enforced_limits())?;
    validate_native_capabilities(&hello.native_capabilities)?;

    Ok(AgentHelloContext {
        versions,
        contract_version: hello.contract_version.clone(),
        supported_features: FeatureSet::from_bits(hello.supported_feature_bits),
    })
}

pub(super) fn validate_host_hello(
    hello: &wire::HostHello,
    agent: &AgentHelloContext,
    launch: &RunnerLaunchContext,
) -> Result<ConnectionContext, ControlError> {
    let selected = protocol_version(*hello.selected_protocol.as_ref().ok_or(
        ControlError::InvalidHostHello("selected protocol is missing"),
    )?)?;
    if selected < agent.versions.min || selected > agent.versions.max || selected.major != 1 {
        return Err(ControlError::InvalidHostHello(
            "selected protocol was not offered",
        ));
    }
    validate_text(&hello.connection_id).map_err(ControlError::InvalidHostHello)?;
    let connection_id = ConnectionId::new(hello.connection_id.clone())
        .map_err(|_| ControlError::InvalidHostHello("connection ID is empty"))?;
    if &connection_id != launch.expected_connection_id() {
        return Err(ControlError::InvalidHostHello(
            "connection ID differs from launch context",
        ));
    }
    if hello.contract_version != agent.contract_version
        || hello.contract_schema_version != SUPPORTED_SPEC_SCHEMA_VERSION
    {
        return Err(ControlError::InvalidHostHello(
            "contract version differs from AgentHello",
        ));
    }
    if hello.heartbeat_interval_ms == 0 || hello.heartbeat_timeout_ms < hello.heartbeat_interval_ms
    {
        return Err(ControlError::InvalidHostHello(
            "heartbeat timing is invalid",
        ));
    }
    let frame_limits = validate_frame_limits(
        hello
            .frame_limits
            .as_ref()
            .ok_or(ControlError::InvalidHostHello("frame limits are missing"))?,
        launch,
    )?;
    if !(BOOTSTRAP_SECRET_MIN_BYTES..=SESSION_TOKEN_MAX_BYTES)
        .contains(&hello.connection_session_token.len())
        || !launch.connection_session_token_matches(&hello.connection_session_token)
    {
        return Err(ControlError::InvalidHostHello(
            "connection session token differs from launch context",
        ));
    }
    let supported = agent.supported_features.bits();
    if hello.allowed_feature_bits & !supported != 0
        || hello.required_feature_bits & !hello.allowed_feature_bits != 0
    {
        return Err(ControlError::InvalidHostHello(
            "feature selection is invalid",
        ));
    }

    Ok(ConnectionContext {
        connection_id,
        negotiated: NegotiatedProtocol {
            version: selected,
            features: FeatureSet::from_bits(hello.allowed_feature_bits),
        },
        max_frame_bytes: frame_limits.maximum_frame_bytes,
        read_timeout_ms: frame_limits.read_timeout_ms,
        write_timeout_ms: frame_limits.write_timeout_ms,
        heartbeat_interval_ms: hello.heartbeat_interval_ms,
    })
}

fn protocol_range(value: &wire::ProtocolVersionRange) -> Result<ProtocolRange, ControlError> {
    let minimum = protocol_version(*value.minimum.as_ref().ok_or(
        ControlError::InvalidAgentHello("minimum protocol is missing"),
    )?)?;
    let maximum = protocol_version(*value.maximum.as_ref().ok_or(
        ControlError::InvalidAgentHello("maximum protocol is missing"),
    )?)?;
    let range = ProtocolRange::new(minimum, maximum)
        .map_err(|_| ControlError::InvalidAgentHello("protocol range is inverted"))?;
    if range.min.major != 1 || range.max.major != 1 {
        return Err(ControlError::InvalidAgentHello(
            "only protocol major version 1 is supported",
        ));
    }
    Ok(range)
}

fn protocol_version(value: wire::ProtocolVersion) -> Result<ProtocolVersion, ControlError> {
    let major = u16::try_from(value.major)
        .map_err(|_| ControlError::InvalidHostHello("protocol major exceeds uint16"))?;
    let minor = u16::try_from(value.minor)
        .map_err(|_| ControlError::InvalidHostHello("protocol minor exceeds uint16"))?;
    if major == 0 {
        return Err(ControlError::InvalidHostHello(
            "protocol major cannot be zero",
        ));
    }
    Ok(ProtocolVersion::new(major, minor))
}

fn validate_provenance(
    value: &wire::RuntimeProvenance,
    launch: &RunnerLaunchContext,
) -> Result<(), ControlError> {
    for text in [
        value.build_id.as_str(),
        value.source_commit.as_str(),
        value.runtime_instance_id.as_str(),
        value.operating_system.as_str(),
        value.architecture.as_str(),
    ] {
        validate_text(text).map_err(ControlError::InvalidAgentHello)?;
    }
    if value.runtime_instance_id != launch.runtime_instance_id().as_str()
        || value.binary_sha256.len() != 32
        || value.pid == 0
    {
        return Err(ControlError::InvalidAgentHello(
            "runtime provenance differs from launch context",
        ));
    }
    Ok(())
}

fn validate_text(value: &str) -> Result<(), &'static str> {
    if value.trim().is_empty() {
        return Err("text field is empty");
    }
    if value.contains('\0') {
        return Err("text field contains NUL");
    }
    if value.len() > MAX_HELLO_TEXT_BYTES {
        return Err("text field exceeds 512 bytes");
    }
    Ok(())
}
