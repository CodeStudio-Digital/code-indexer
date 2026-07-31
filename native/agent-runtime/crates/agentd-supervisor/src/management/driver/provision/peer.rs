use std::fmt::{self, Debug, Formatter};

use agent_protocol::generated::v1 as wire;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtectedLaunchPeerAuthorityError {
    ZeroProcessId,
    DuplicateProcessId,
    IncompleteUnixIdentity,
    MissingUnixIdentity,
    SupervisorProcessIdMismatch,
    UnexpectedUnixIdentity,
}

/// OS-authenticated identities of the only local peers a runner may accept.
///
/// These values must come from the physical launcher/transport boundary, never
/// from `HostSupervisorHello` or `LaunchAttemptProcess`.
///
/// Production construction remains intentionally unavailable until that
/// physical adapter returns an opaque authentication receipt.
#[derive(Clone, PartialEq, Eq)]
pub struct ProtectedLaunchPeerAuthority {
    host: wire::RunnerExpectedLocalPeer,
    supervisor: wire::RunnerExpectedLocalPeer,
}

#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "Windows consumes peer facts; other platform provisioners remain gated"
    )
)]
impl ProtectedLaunchPeerAuthority {
    #[cfg(windows)]
    pub(crate) fn from_authenticated_windows_host(
        host_process_id: u32,
    ) -> Result<Self, ProtectedLaunchPeerAuthorityError> {
        Self::new(host_process_id, std::process::id(), None, None)
    }

    /// Creates explicit peer authority for tests on the current target platform.
    ///
    /// Unix requires both user IDs. Windows rejects both user IDs.
    ///
    /// # Errors
    ///
    /// Rejects zero/equal process IDs, a supervisor PID different from this
    /// process, and platform-incompatible Unix identity.
    #[cfg(test)]
    pub(crate) fn new_for_test(
        host_process_id: u32,
        supervisor_process_id: u32,
        host_unix_user_id: Option<u32>,
        supervisor_unix_user_id: Option<u32>,
    ) -> Result<Self, ProtectedLaunchPeerAuthorityError> {
        Self::new(
            host_process_id,
            supervisor_process_id,
            host_unix_user_id,
            supervisor_unix_user_id,
        )
    }

    fn new(
        host_process_id: u32,
        supervisor_process_id: u32,
        host_unix_user_id: Option<u32>,
        supervisor_unix_user_id: Option<u32>,
    ) -> Result<Self, ProtectedLaunchPeerAuthorityError> {
        if host_process_id == 0 || supervisor_process_id == 0 {
            return Err(ProtectedLaunchPeerAuthorityError::ZeroProcessId);
        }
        if host_process_id == supervisor_process_id {
            return Err(ProtectedLaunchPeerAuthorityError::DuplicateProcessId);
        }
        if host_unix_user_id.is_some() != supervisor_unix_user_id.is_some() {
            return Err(ProtectedLaunchPeerAuthorityError::IncompleteUnixIdentity);
        }
        #[cfg(windows)]
        if host_unix_user_id.is_some() {
            return Err(ProtectedLaunchPeerAuthorityError::UnexpectedUnixIdentity);
        }
        #[cfg(unix)]
        if host_unix_user_id.is_none() {
            return Err(ProtectedLaunchPeerAuthorityError::MissingUnixIdentity);
        }
        if supervisor_process_id != std::process::id() {
            return Err(ProtectedLaunchPeerAuthorityError::SupervisorProcessIdMismatch);
        }
        Ok(Self {
            host: wire::RunnerExpectedLocalPeer {
                process_id: host_process_id,
                unix_user_id: host_unix_user_id,
            },
            supervisor: wire::RunnerExpectedLocalPeer {
                process_id: supervisor_process_id,
                unix_user_id: supervisor_unix_user_id,
            },
        })
    }

    #[must_use]
    pub(in crate::management::driver) const fn expected_host_peer(
        &self,
    ) -> wire::RunnerExpectedLocalPeer {
        self.host
    }

    #[must_use]
    pub(in crate::management::driver) const fn expected_supervisor_peer(
        &self,
    ) -> wire::RunnerExpectedLocalPeer {
        self.supervisor
    }

    pub(super) const fn contains_process_id(&self, process_id: u32) -> bool {
        self.host.process_id == process_id || self.supervisor.process_id == process_id
    }
}

impl Debug for ProtectedLaunchPeerAuthority {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProtectedLaunchPeerAuthority")
            .field("host", &"[REDACTED]")
            .field("supervisor", &"[REDACTED]")
            .finish()
    }
}

#[cfg(test)]
mod tests;
