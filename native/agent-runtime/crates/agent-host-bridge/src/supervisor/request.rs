use std::fmt::{self, Debug, Formatter};
use std::path::PathBuf;
use std::time::Duration;

use agent_platform::ipc::EndpointName;
use agent_protocol::bootstrap_limits::{
    BOOTSTRAP_SECRET_MIN_BYTES, LAUNCH_NONCE_MAX_BYTES, SESSION_TOKEN_MAX_BYTES,
};
use agent_protocol::generated::v1 as wire;
use agent_protocol::identity::ConnectionId;
use agent_protocol::supervisor_bootstrap::SUPERVISOR_BOOTSTRAP_SCHEMA_VERSION;
use prost::Message;
use zeroize::{Zeroize, Zeroizing};

use super::HostSupervisorBridgeError;

pub const HOST_SUPERVISOR_BRIDGE_OPEN_MAX_BYTES: usize = 64 * 1024;
const MAX_TEXT_BYTES: usize = 512;
const MIN_STARTUP_TIMEOUT_MS: u64 = 100;
const MAX_STARTUP_TIMEOUT_MS: u64 = 30_000;

pub(super) struct HostSupervisorLaunchPlan {
    pub endpoint_name: EndpointName,
    pub connection_id: ConnectionId,
    pub management_session_token: Vec<u8>,
    pub supervisor_launch_nonce: Vec<u8>,
    pub trusted_supervisor: wire::ExpectedRuntimeProvenance,
    pub trusted_runner: wire::ExpectedRuntimeProvenance,
    pub selected_protocol: wire::ProtocolVersion,
    pub supervisor_executable: PathBuf,
    pub runner_executable: PathBuf,
    pub package_directory: PathBuf,
    pub startup_timeout: Duration,
}

impl HostSupervisorLaunchPlan {
    pub fn decode(encoded: Vec<u8>) -> Result<Self, HostSupervisorBridgeError> {
        if encoded.is_empty() {
            return Err(HostSupervisorBridgeError::EmptyRequest);
        }
        if encoded.len() > HOST_SUPERVISOR_BRIDGE_OPEN_MAX_BYTES {
            return Err(HostSupervisorBridgeError::RequestTooLarge {
                length: encoded.len(),
                maximum: HOST_SUPERVISOR_BRIDGE_OPEN_MAX_BYTES,
            });
        }
        let encoded = Zeroizing::new(encoded);
        let decoded = wire::HostSupervisorBridgeOpenRequest::decode(encoded.as_slice())
            .map_err(HostSupervisorBridgeError::MalformedRequest)?;
        validate(ScrubbedRequest(decoded))
    }

    pub(super) fn mint_handoff(
        &mut self,
        supervisor_process_id: u32,
        management_endpoint_address: &str,
        containment: wire::ContainmentCapabilities,
    ) -> wire::SupervisorProcessHandoff {
        let protocol = self.selected_protocol;
        wire::SupervisorProcessHandoff {
            schema_version: SUPERVISOR_BOOTSTRAP_SCHEMA_VERSION,
            host_process_id: std::process::id(),
            management_connection_id: self.connection_id.as_str().to_owned(),
            management_endpoint_address: management_endpoint_address.to_owned(),
            management_session_token: std::mem::take(&mut self.management_session_token),
            supervisor_launch_nonce: std::mem::take(&mut self.supervisor_launch_nonce),
            supervisor_provenance: Some(wire::RuntimeProvenance {
                build_id: self.trusted_supervisor.build_id.clone(),
                source_commit: self.trusted_supervisor.source_commit.clone(),
                binary_sha256: self.trusted_supervisor.binary_sha256.clone(),
                runtime_instance_id: format!("supervisor:{}", self.connection_id.as_str()),
                pid: supervisor_process_id,
                operating_system: self.trusted_supervisor.operating_system.clone(),
                architecture: self.trusted_supervisor.architecture.clone(),
            }),
            supported_protocols: Some(wire::ProtocolVersionRange {
                minimum: Some(protocol),
                maximum: Some(protocol),
            }),
            containment: Some(containment),
            supported_feature_bits: 0,
            runner_executable: self.runner_executable.to_string_lossy().into_owned(),
            runner_working_directory: self.package_directory.to_string_lossy().into_owned(),
            runner_environment: Vec::new(),
            trusted_runner_provenance: Some(self.trusted_runner.clone()),
        }
    }
}

impl Debug for HostSupervisorLaunchPlan {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HostSupervisorLaunchPlan")
            .field("connection_id", &self.connection_id)
            .field("package", &"[VERIFIED; REDACTED]")
            .field("secrets", &"[OWNED; REDACTED]")
            .field("startup_timeout", &self.startup_timeout)
            .finish_non_exhaustive()
    }
}

impl Drop for HostSupervisorLaunchPlan {
    fn drop(&mut self) {
        self.management_session_token.zeroize();
        self.supervisor_launch_nonce.zeroize();
    }
}

fn validate(
    mut request: ScrubbedRequest,
) -> Result<HostSupervisorLaunchPlan, HostSupervisorBridgeError> {
    let value = &request.0;
    valid(
        value.schema_version == SUPERVISOR_BOOTSTRAP_SCHEMA_VERSION,
        "schema_version",
    )?;
    let endpoint_name = EndpointName::new(value.management_endpoint_name.clone())
        .map_err(|_| HostSupervisorBridgeError::InvalidRequest("management_endpoint_name"))?;
    let connection_id = ConnectionId::new(value.management_connection_id.clone())
        .map_err(|_| HostSupervisorBridgeError::InvalidRequest("management_connection_id"))?;
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
        value.trusted_supervisor_provenance.as_ref(),
        "trusted_supervisor_provenance",
    )?;
    validate_provenance(
        value.trusted_runner_provenance.as_ref(),
        "trusted_runner_provenance",
    )?;
    let protocol = value
        .selected_protocol
        .ok_or(HostSupervisorBridgeError::InvalidRequest(
            "selected_protocol",
        ))?;
    valid(protocol.major != 0, "selected_protocol")?;
    let supervisor_executable =
        absolute_path(&value.supervisor_executable, "supervisor_executable")?;
    let runner_executable = absolute_path(&value.runner_executable, "runner_executable")?;
    valid(
        supervisor_executable != runner_executable,
        "runtime_executables",
    )?;
    let package_directory = supervisor_executable
        .parent()
        .filter(|parent| runner_executable.parent() == Some(*parent))
        .ok_or(HostSupervisorBridgeError::InvalidRequest(
            "runtime_package_directory",
        ))?
        .to_path_buf();
    valid(
        (MIN_STARTUP_TIMEOUT_MS..=MAX_STARTUP_TIMEOUT_MS).contains(&value.startup_timeout_ms),
        "startup_timeout_ms",
    )?;
    let management_session_token = std::mem::take(&mut request.0.management_session_token);
    let supervisor_launch_nonce = std::mem::take(&mut request.0.supervisor_launch_nonce);
    Ok(HostSupervisorLaunchPlan {
        endpoint_name,
        connection_id,
        management_session_token,
        supervisor_launch_nonce,
        trusted_supervisor: request
            .0
            .trusted_supervisor_provenance
            .take()
            .expect("validated supervisor provenance"),
        trusted_runner: request
            .0
            .trusted_runner_provenance
            .take()
            .expect("validated runner provenance"),
        selected_protocol: protocol,
        supervisor_executable,
        runner_executable,
        package_directory,
        startup_timeout: Duration::from_millis(request.0.startup_timeout_ms),
    })
}

fn absolute_path(value: &str, field: &'static str) -> Result<PathBuf, HostSupervisorBridgeError> {
    valid(
        !value.trim().is_empty() && value.len() <= 32 * 1024 && !value.contains('\0'),
        field,
    )?;
    let path = PathBuf::from(value);
    valid(path.is_absolute(), field)?;
    Ok(path)
}

fn validate_provenance(
    value: Option<&wire::ExpectedRuntimeProvenance>,
    field: &'static str,
) -> Result<(), HostSupervisorBridgeError> {
    let value = value.ok_or(HostSupervisorBridgeError::InvalidRequest(field))?;
    for text in [
        &value.build_id,
        &value.source_commit,
        &value.operating_system,
        &value.architecture,
    ] {
        valid(
            !text.trim().is_empty() && text.len() <= MAX_TEXT_BYTES && !text.contains('\0'),
            field,
        )?;
    }
    valid(value.binary_sha256.len() == 32, field)
}

fn valid_secret(
    value: &[u8],
    maximum: usize,
    field: &'static str,
) -> Result<(), HostSupervisorBridgeError> {
    valid(
        (BOOTSTRAP_SECRET_MIN_BYTES..=maximum).contains(&value.len()),
        field,
    )
}

const fn valid(condition: bool, field: &'static str) -> Result<(), HostSupervisorBridgeError> {
    if condition {
        Ok(())
    } else {
        Err(HostSupervisorBridgeError::InvalidRequest(field))
    }
}

struct ScrubbedRequest(wire::HostSupervisorBridgeOpenRequest);

impl Drop for ScrubbedRequest {
    fn drop(&mut self) {
        self.0.management_session_token.zeroize();
        self.0.supervisor_launch_nonce.zeroize();
    }
}
