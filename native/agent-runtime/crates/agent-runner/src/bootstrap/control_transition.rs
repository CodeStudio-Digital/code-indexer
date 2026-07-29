use std::error::Error;
use std::fmt::{self, Debug, Display, Formatter};
use std::io::{Read, Write};

use agent_platform::windows::ipc::WindowsProtectedEndpoint;
use agent_protocol::generated::v1 as wire;
use agent_protocol::runner_bootstrap::{
    PendingRunnerLaunchNonce, RunnerBootstrapError as LaunchBootstrapError,
    ShapeValidatedRunnerLaunchHandoff,
};

use crate::control::{
    AsyncRunnerBootstrapDriver, AsyncRunnerBootstrapError, AsyncRunnerControlDriver,
    CONTROL_PLANE_CONTRACT_VERSION, CONTROL_PLANE_SCHEMA_VERSION, CONTROL_PROTOCOL_MAJOR,
    CONTROL_PROTOCOL_MINOR, LaunchContextError, RunnerBootstrapDriver, RunnerBootstrapError,
    RunnerControlDriver, RunnerLaunchContext,
};

use super::MaterializedRunnerBootstrap;

/// Paired launch context and nonce authority from one exact handoff.
pub struct PendingRunnerControlLaunch {
    pub(super) context: RunnerLaunchContext,
    pub(super) nonce: PendingRunnerLaunchNonce,
}

/// Materialized listeners plus the sole authority that may start control.
///
/// The process entrypoint consumes this owner into the expected-Host accept
/// pump. Data and pulse remain retained and cannot grant execution authority.
pub struct PreparedRunnerControlLaunch {
    pub(super) pending: PendingRunnerControlLaunch,
    pub(super) handoff: ShapeValidatedRunnerLaunchHandoff,
    pub(super) control: WindowsProtectedEndpoint,
    pub(super) data: WindowsProtectedEndpoint,
    pub(super) runner_pulse: WindowsProtectedEndpoint,
}

#[derive(Debug)]
pub enum RunnerControlTransitionError {
    LaunchBootstrap(LaunchBootstrapError),
    MissingLaunchNonce,
    LaunchContext(LaunchContextError),
    MissingRuntimeProvenance,
    MissingContainmentCapabilities,
}

impl Debug for PendingRunnerControlLaunch {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingRunnerControlLaunch")
            .field("context", &self.context)
            .field("nonce", &"[OWNED; REDACTED]")
            .finish()
    }
}

impl Debug for PreparedRunnerControlLaunch {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PreparedRunnerControlLaunch")
            .field("pending", &self.pending)
            .field("handoff", &"[RETAINED; SECRETS REDACTED]")
            .field("listeners", &3)
            .finish_non_exhaustive()
    }
}

impl MaterializedRunnerBootstrap {
    /// Consumes physical bootstrap ownership into the sole control launch.
    ///
    /// # Errors
    ///
    /// Missing/consumed secret authority or a verifier from another endpoint
    /// drops all listeners and fails closed.
    pub fn prepare_control_launch(
        mut self,
    ) -> Result<PreparedRunnerControlLaunch, RunnerControlTransitionError> {
        let verifier = self
            .handoff
            .take_endpoint_token_verifier(wire::AttemptEndpointKind::Control)
            .map_err(RunnerControlTransitionError::LaunchBootstrap)?;
        let nonce = self
            .handoff
            .take_launch_nonce()
            .ok_or(RunnerControlTransitionError::MissingLaunchNonce)?;
        let context = RunnerLaunchContext::from_validated_handoff(&self.handoff, verifier)
            .map_err(RunnerControlTransitionError::LaunchContext)?;
        Ok(PreparedRunnerControlLaunch {
            pending: PendingRunnerControlLaunch { context, nonce },
            handoff: self.handoff,
            control: self.control,
            data: self.data,
            runner_pulse: self.runner_pulse,
        })
    }
}

impl PreparedRunnerControlLaunch {
    /// Builds the nonce-free Hello only from protected handoff facts.
    ///
    /// # Errors
    ///
    /// Rejects incomplete protected provenance or containment metadata.
    pub(crate) fn protected_agent_hello_draft(
        &self,
    ) -> Result<wire::AgentHello, RunnerControlTransitionError> {
        let metadata = self.handoff.metadata();
        let provenance = metadata
            .runtime_provenance
            .clone()
            .ok_or(RunnerControlTransitionError::MissingRuntimeProvenance)?;
        let containment = metadata
            .effective_containment
            .as_ref()
            .and_then(|report| report.capabilities)
            .ok_or(RunnerControlTransitionError::MissingContainmentCapabilities)?;
        Ok(wire::AgentHello {
            supported_protocols: Some(wire::ProtocolVersionRange {
                minimum: Some(wire::ProtocolVersion {
                    major: CONTROL_PROTOCOL_MAJOR,
                    minor: CONTROL_PROTOCOL_MINOR,
                }),
                maximum: Some(wire::ProtocolVersion {
                    major: CONTROL_PROTOCOL_MAJOR,
                    minor: CONTROL_PROTOCOL_MINOR,
                }),
            }),
            contract_version: CONTROL_PLANE_CONTRACT_VERSION.into(),
            contract_schema_version: CONTROL_PLANE_SCHEMA_VERSION,
            provenance: Some(provenance),
            launch_nonce: Vec::new(),
            containment: Some(containment),
            supported_feature_bits: 0,
            native_capabilities: Vec::new(),
        })
    }

    /// Splits listener ownership while keeping context and nonce inseparable.
    #[must_use]
    #[cfg(test)]
    pub(crate) fn into_accept_parts(
        self,
    ) -> (
        PendingRunnerControlLaunch,
        ShapeValidatedRunnerLaunchHandoff,
        WindowsProtectedEndpoint,
        WindowsProtectedEndpoint,
        WindowsProtectedEndpoint,
    ) {
        (
            self.pending,
            self.handoff,
            self.control,
            self.data,
            self.runner_pulse,
        )
    }
}

impl PendingRunnerControlLaunch {
    /// Sends the nonce-bearing Hello and completes negotiation on one stream.
    ///
    /// # Errors
    ///
    /// Invalid draft, transport, nonce commit, or `HostHello` closes the stream.
    pub fn establish<R: Read, W: Write>(
        self,
        reader: R,
        writer: W,
        agent_hello_draft: wire::AgentHello,
    ) -> Result<RunnerControlDriver<R, W>, RunnerBootstrapError> {
        RunnerBootstrapDriver::from_validated_launch(reader, writer, self.context)?
            .establish_with_nonce(agent_hello_draft, self.nonce)
    }

    #[allow(
        dead_code,
        reason = "called only by the internal pre-active service before its process pump lands"
    )]
    pub(super) async fn establish_async<S>(
        self,
        stream: S,
        agent_hello_draft: wire::AgentHello,
        deadline: tokio::time::Instant,
    ) -> Result<AsyncRunnerControlDriver<S>, AsyncRunnerBootstrapError>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + 'static,
    {
        AsyncRunnerBootstrapDriver::from_validated_launch(stream, self.context)?
            .establish_with_nonce(agent_hello_draft, self.nonce, deadline)
            .await
    }
}

impl Display for RunnerControlTransitionError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::LaunchBootstrap(_) => {
                formatter.write_str("cannot extract control endpoint authority")
            }
            Self::MissingLaunchNonce => formatter.write_str("launch nonce authority is missing"),
            Self::LaunchContext(_) => formatter.write_str("cannot derive runner launch context"),
            Self::MissingRuntimeProvenance => {
                formatter.write_str("protected runner provenance is missing")
            }
            Self::MissingContainmentCapabilities => {
                formatter.write_str("protected containment capabilities are missing")
            }
        }
    }
}

impl Error for RunnerControlTransitionError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::LaunchBootstrap(source) => Some(source),
            Self::LaunchContext(source) => Some(source),
            Self::MissingLaunchNonce
            | Self::MissingRuntimeProvenance
            | Self::MissingContainmentCapabilities => None,
        }
    }
}
