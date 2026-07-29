use crate::generated::v1 as wire;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagementPayloadKind {
    HostSupervisorHello,
    SupervisorHello,
    LaunchAttemptProcess,
    LaunchAccepted,
    LaunchRejected,
    AttemptProcessSpawned,
    AttemptContainmentReport,
    UpdateAttemptAuthority,
    CancelAttemptProcess,
    FenceAttemptProcess,
    ReapAttemptProcess,
    AttemptProcessExited,
    AttemptProcessReaped,
    QuerySupervisorState,
    SupervisorState,
    ShutdownSupervisor,
    SupervisorResourceSample,
    SupervisorFault,
    ManagementAck,
}

impl ManagementPayloadKind {
    pub(super) const fn from_body(body: &wire::management_payload::Body) -> Self {
        use wire::management_payload::Body;

        match body {
            Body::HostSupervisorHello(_) => Self::HostSupervisorHello,
            Body::SupervisorHello(_) => Self::SupervisorHello,
            Body::LaunchAttemptProcess(_) => Self::LaunchAttemptProcess,
            Body::LaunchAccepted(_) => Self::LaunchAccepted,
            Body::LaunchRejected(_) => Self::LaunchRejected,
            Body::AttemptProcessSpawned(_) => Self::AttemptProcessSpawned,
            Body::AttemptContainmentReport(_) => Self::AttemptContainmentReport,
            Body::UpdateAttemptAuthority(_) => Self::UpdateAttemptAuthority,
            Body::CancelAttemptProcess(_) => Self::CancelAttemptProcess,
            Body::FenceAttemptProcess(_) => Self::FenceAttemptProcess,
            Body::ReapAttemptProcess(_) => Self::ReapAttemptProcess,
            Body::AttemptProcessExited(_) => Self::AttemptProcessExited,
            Body::AttemptProcessReaped(_) => Self::AttemptProcessReaped,
            Body::QuerySupervisorState(_) => Self::QuerySupervisorState,
            Body::SupervisorState(_) => Self::SupervisorState,
            Body::ShutdownSupervisor(_) => Self::ShutdownSupervisor,
            Body::SupervisorResourceSample(_) => Self::SupervisorResourceSample,
            Body::SupervisorFault(_) => Self::SupervisorFault,
            Body::ManagementAck(_) => Self::ManagementAck,
        }
    }

    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::HostSupervisorHello => "HostSupervisorHello",
            Self::SupervisorHello => "SupervisorHello",
            Self::LaunchAttemptProcess => "LaunchAttemptProcess",
            Self::LaunchAccepted => "LaunchAccepted",
            Self::LaunchRejected => "LaunchRejected",
            Self::AttemptProcessSpawned => "AttemptProcessSpawned",
            Self::AttemptContainmentReport => "AttemptContainmentReport",
            Self::UpdateAttemptAuthority => "UpdateAttemptAuthority",
            Self::CancelAttemptProcess => "CancelAttemptProcess",
            Self::FenceAttemptProcess => "FenceAttemptProcess",
            Self::ReapAttemptProcess => "ReapAttemptProcess",
            Self::AttemptProcessExited => "AttemptProcessExited",
            Self::AttemptProcessReaped => "AttemptProcessReaped",
            Self::QuerySupervisorState => "QuerySupervisorState",
            Self::SupervisorState => "SupervisorState",
            Self::ShutdownSupervisor => "ShutdownSupervisor",
            Self::SupervisorResourceSample => "SupervisorResourceSample",
            Self::SupervisorFault => "SupervisorFault",
            Self::ManagementAck => "ManagementAck",
        }
    }
}

pub(super) const fn management_payload_name(body: &wire::management_payload::Body) -> &'static str {
    ManagementPayloadKind::from_body(body).name()
}
