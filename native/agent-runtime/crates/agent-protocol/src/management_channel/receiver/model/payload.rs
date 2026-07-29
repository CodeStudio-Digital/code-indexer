use std::fmt::{self, Debug, Formatter};

use crate::generated::v1 as wire;
use crate::management_channel::payload::ManagementPayloadKind;
use crate::management_secrets::scrub_protected_body;

/// A payload whose direction, framing, correlation, and V1 semantic contract
/// were checked by the channel before it was exposed.
pub struct ValidatedManagementPayload {
    body: wire::management_payload::Body,
    kind: ManagementPayloadKind,
}

impl Debug for ValidatedManagementPayload {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ValidatedManagementPayload")
            .field("kind", &self.kind.name())
            .field("payload", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}

impl ValidatedManagementPayload {
    pub(super) const fn new(body: wire::management_payload::Body) -> Self {
        let kind = ManagementPayloadKind::from_body(&body);
        Self { body, kind }
    }

    #[must_use]
    pub const fn kind(&self) -> ManagementPayloadKind {
        self.kind
    }

    #[must_use]
    pub const fn launch_attempt_process(&self) -> Option<&wire::LaunchAttemptProcess> {
        match &self.body {
            wire::management_payload::Body::LaunchAttemptProcess(value) => Some(value),
            _ => None,
        }
    }

    /// Transfers the validated launch body to the physical launch owner.
    ///
    /// The replacement keeps this value droppable without duplicating launch
    /// secrets. Calling this for another payload kind returns `None` after
    /// scrubbing the removed body.
    #[must_use]
    pub fn into_launch_attempt_process(mut self) -> Option<wire::LaunchAttemptProcess> {
        let replacement =
            wire::management_payload::Body::SupervisorState(wire::SupervisorState::default());
        let mut body = std::mem::replace(&mut self.body, replacement);
        if let wire::management_payload::Body::LaunchAttemptProcess(launch) = body {
            Some(launch)
        } else {
            scrub_protected_body(&mut body);
            None
        }
    }

    #[must_use]
    pub const fn launch_accepted(&self) -> Option<&wire::LaunchAccepted> {
        match &self.body {
            wire::management_payload::Body::LaunchAccepted(value) => Some(value),
            _ => None,
        }
    }

    #[must_use]
    pub const fn launch_rejected(&self) -> Option<&wire::LaunchRejected> {
        match &self.body {
            wire::management_payload::Body::LaunchRejected(value) => Some(value),
            _ => None,
        }
    }

    #[must_use]
    pub const fn cancel_attempt_process(&self) -> Option<&wire::CancelAttemptProcess> {
        match &self.body {
            wire::management_payload::Body::CancelAttemptProcess(value) => Some(value),
            _ => None,
        }
    }

    #[must_use]
    pub const fn fence_attempt_process(&self) -> Option<&wire::FenceAttemptProcess> {
        match &self.body {
            wire::management_payload::Body::FenceAttemptProcess(value) => Some(value),
            _ => None,
        }
    }

    #[must_use]
    pub const fn reap_attempt_process(&self) -> Option<&wire::ReapAttemptProcess> {
        match &self.body {
            wire::management_payload::Body::ReapAttemptProcess(value) => Some(value),
            _ => None,
        }
    }

    #[must_use]
    pub const fn shutdown_supervisor(&self) -> Option<&wire::ShutdownSupervisor> {
        match &self.body {
            wire::management_payload::Body::ShutdownSupervisor(value) => Some(value),
            _ => None,
        }
    }

    #[must_use]
    pub const fn supervisor_state(&self) -> Option<&wire::SupervisorState> {
        match &self.body {
            wire::management_payload::Body::SupervisorState(value) => Some(value),
            _ => None,
        }
    }

    #[must_use]
    pub const fn management_ack(&self) -> Option<&wire::ManagementAck> {
        match &self.body {
            wire::management_payload::Body::ManagementAck(value) => Some(value),
            _ => None,
        }
    }
}

impl Drop for ValidatedManagementPayload {
    fn drop(&mut self) {
        scrub_protected_body(&mut self.body);
    }
}
