use crate::generated::v1 as wire;

use super::payload::{ManagementPayloadKind, management_payload_name};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagementDirection {
    HostToSupervisor,
    SupervisorToHost,
}

impl ManagementDirection {
    pub(super) const fn reverse(self) -> Self {
        match self {
            Self::HostToSupervisor => Self::SupervisorToHost,
            Self::SupervisorToHost => Self::HostToSupervisor,
        }
    }

    pub(super) const fn label(self) -> &'static str {
        match self {
            Self::HostToSupervisor => "host",
            Self::SupervisorToHost => "supervisor",
        }
    }
}

pub(super) const fn payload_allowed(
    direction: ManagementDirection,
    body: &wire::management_payload::Body,
) -> bool {
    use wire::management_payload::Body;

    matches!(
        (direction, body),
        (
            ManagementDirection::HostToSupervisor,
            Body::LaunchAttemptProcess(_)
                | Body::UpdateAttemptAuthority(_)
                | Body::CancelAttemptProcess(_)
                | Body::FenceAttemptProcess(_)
                | Body::ReapAttemptProcess(_)
                | Body::QuerySupervisorState(_)
                | Body::ShutdownSupervisor(_)
                | Body::ManagementAck(_)
        ) | (
            ManagementDirection::SupervisorToHost,
            Body::LaunchAccepted(_)
                | Body::LaunchRejected(_)
                | Body::AttemptProcessSpawned(_)
                | Body::AttemptContainmentReport(_)
                | Body::AttemptProcessExited(_)
                | Body::AttemptProcessReaped(_)
                | Body::SupervisorState(_)
                | Body::SupervisorResourceSample(_)
                | Body::SupervisorFault(_)
                | Body::ManagementAck(_)
        )
    )
}

pub(super) const fn forbidden_payload(
    direction: ManagementDirection,
    body: &wire::management_payload::Body,
) -> super::ManagementChannelError {
    super::ManagementChannelError::PayloadNotAllowed {
        direction,
        payload: management_payload_name(body),
    }
}

pub(super) const fn new_payload_allowed(
    direction: ManagementDirection,
    body: &wire::management_payload::Body,
) -> bool {
    use ManagementPayloadKind as Kind;

    matches!(
        (direction, ManagementPayloadKind::from_body(body)),
        (
            ManagementDirection::HostToSupervisor,
            Kind::LaunchAttemptProcess
                | Kind::UpdateAttemptAuthority
                | Kind::CancelAttemptProcess
                | Kind::FenceAttemptProcess
                | Kind::ReapAttemptProcess
                | Kind::QuerySupervisorState
                | Kind::ShutdownSupervisor
        ) | (
            ManagementDirection::SupervisorToHost,
            Kind::AttemptProcessSpawned
                | Kind::AttemptContainmentReport
                | Kind::AttemptProcessExited
                | Kind::AttemptProcessReaped
                | Kind::SupervisorResourceSample
                | Kind::SupervisorFault
        )
    )
}

pub(super) const fn response_payload_allowed(
    inbound: ManagementPayloadKind,
    outbound: &wire::management_payload::Body,
) -> bool {
    use ManagementPayloadKind as Kind;

    matches!(
        (inbound, ManagementPayloadKind::from_body(outbound)),
        (
            Kind::LaunchAttemptProcess,
            Kind::LaunchAccepted | Kind::LaunchRejected
        ) | (Kind::QuerySupervisorState, Kind::SupervisorState)
            | (
                Kind::UpdateAttemptAuthority
                    | Kind::CancelAttemptProcess
                    | Kind::FenceAttemptProcess
                    | Kind::ReapAttemptProcess
                    | Kind::ShutdownSupervisor
                    | Kind::LaunchAccepted
                    | Kind::LaunchRejected
                    | Kind::AttemptProcessSpawned
                    | Kind::AttemptContainmentReport
                    | Kind::AttemptProcessExited
                    | Kind::AttemptProcessReaped
                    | Kind::SupervisorState
                    | Kind::SupervisorResourceSample
                    | Kind::SupervisorFault,
                Kind::ManagementAck
            )
    )
}
