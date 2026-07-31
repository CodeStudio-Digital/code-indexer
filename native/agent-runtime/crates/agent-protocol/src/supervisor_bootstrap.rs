//! Private Host-to-supervisor process bootstrap.
//!
//! The inherited transport carries exactly one bounded handoff and one Ready
//! response. Permanent management frames use the protected endpoint named by
//! the handoff and never share this bootstrap stream.

use std::fmt::{self, Debug, Formatter};

use crate::generated::v1 as wire;
use crate::identity::ConnectionId;
use zeroize::Zeroize;

mod error;
mod transport;
mod validation;

pub use error::SupervisorBootstrapError;
pub use transport::{
    ReceivedSupervisorProcessHandoff, SentSupervisorProcessHandoff,
    SupervisorBootstrapReadyTransport, SupervisorPhysicalBootstrapReceiver,
    SupervisorPhysicalBootstrapSender,
};

pub const SUPERVISOR_BOOTSTRAP_SCHEMA_VERSION: u32 = 1;
pub const SUPERVISOR_PROCESS_HANDOFF_MAX_BYTES: usize = 64 * 1024;
pub const SUPERVISOR_PROCESS_READY_MAX_BYTES: usize = 4 * 1024;

/// Shape-validated process handoff with secret bytes retained by one owner.
pub struct ValidatedSupervisorProcessHandoff {
    handoff: wire::SupervisorProcessHandoff,
    connection_id: ConnectionId,
}

impl ValidatedSupervisorProcessHandoff {
    #[must_use]
    pub const fn host_process_id(&self) -> u32 {
        self.handoff.host_process_id
    }

    #[must_use]
    pub const fn connection_id(&self) -> &ConnectionId {
        &self.connection_id
    }

    #[must_use]
    pub fn management_endpoint_address(&self) -> &str {
        &self.handoff.management_endpoint_address
    }

    #[must_use]
    /// # Panics
    ///
    /// Cannot panic for a value returned by the validating bootstrap receiver.
    pub const fn supervisor_provenance(&self) -> &wire::RuntimeProvenance {
        self.handoff
            .supervisor_provenance
            .as_ref()
            .expect("validated supervisor provenance")
    }

    #[must_use]
    /// # Panics
    ///
    /// Cannot panic for a value returned by the validating bootstrap receiver.
    pub const fn supported_protocols(&self) -> &wire::ProtocolVersionRange {
        self.handoff
            .supported_protocols
            .as_ref()
            .expect("validated protocol range")
    }

    #[must_use]
    /// # Panics
    ///
    /// Cannot panic for a value returned by the validating bootstrap receiver.
    pub const fn containment(&self) -> wire::ContainmentCapabilities {
        self.handoff
            .containment
            .expect("validated containment capabilities")
    }

    #[must_use]
    pub const fn supported_feature_bits(&self) -> u64 {
        self.handoff.supported_feature_bits
    }

    #[must_use]
    pub fn runner_executable(&self) -> &str {
        &self.handoff.runner_executable
    }

    #[must_use]
    pub fn runner_working_directory(&self) -> &str {
        &self.handoff.runner_working_directory
    }

    #[must_use]
    pub fn runner_environment(&self) -> &[wire::SupervisorProcessEnvironmentEntry] {
        &self.handoff.runner_environment
    }

    #[must_use]
    /// # Panics
    ///
    /// Cannot panic for a value returned by the validating bootstrap receiver.
    pub const fn trusted_runner_provenance(&self) -> &wire::ExpectedRuntimeProvenance {
        self.handoff
            .trusted_runner_provenance
            .as_ref()
            .expect("validated trusted runner provenance")
    }

    pub fn take_management_session_token(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.handoff.management_session_token)
    }

    pub fn take_supervisor_launch_nonce(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.handoff.supervisor_launch_nonce)
    }

    #[must_use]
    pub fn ready(&self) -> wire::SupervisorProcessReady {
        wire::SupervisorProcessReady {
            schema_version: SUPERVISOR_BOOTSTRAP_SCHEMA_VERSION,
            supervisor_process_id: std::process::id(),
            management_connection_id: self.connection_id.as_str().to_owned(),
            management_endpoint_address: self.handoff.management_endpoint_address.clone(),
        }
    }
}

impl Debug for ValidatedSupervisorProcessHandoff {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ValidatedSupervisorProcessHandoff")
            .field("host_process_id", &"[REDACTED]")
            .field("connection_id", &self.connection_id)
            .field("management_endpoint", &"[PROTECTED]")
            .field("supervisor_provenance", &self.handoff.supervisor_provenance)
            .field("runner_executable", &self.handoff.runner_executable)
            .field("secrets", &"[OWNED; REDACTED]")
            .finish_non_exhaustive()
    }
}

impl Drop for ValidatedSupervisorProcessHandoff {
    fn drop(&mut self) {
        self.handoff.management_session_token.zeroize();
        self.handoff.supervisor_launch_nonce.zeroize();
    }
}

#[cfg(test)]
mod tests;
