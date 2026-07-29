use std::error::Error;
use std::fmt::{self, Debug, Display, Formatter};
use std::io;
use std::time::SystemTimeError;

use agent_protocol::runner_bootstrap::RunnerBootstrapTransportError;

use super::super::RunnerMaterializationError;

pub enum RunnerPhysicalBootstrapError {
    BootstrapOpen(io::Error),
    HandoffReceive(RunnerBootstrapTransportError),
    ExpectedSupervisorMissing,
    CreatorProcessMismatch { expected: u32, actual: u32 },
    ClockBeforeUnixEpoch(SystemTimeError),
    ClockOverflow,
    Materialization(RunnerMaterializationError),
    ReadyCommit(RunnerBootstrapTransportError),
}

impl RunnerPhysicalBootstrapError {
    const fn stage(&self) -> &'static str {
        match self {
            Self::BootstrapOpen(_) => "bootstrap_open",
            Self::HandoffReceive(_) => "handoff_receive",
            Self::ExpectedSupervisorMissing | Self::CreatorProcessMismatch { .. } => {
                "supervisor_authority"
            }
            Self::ClockBeforeUnixEpoch(_) | Self::ClockOverflow => "clock",
            Self::Materialization(_) => "endpoint_materialization",
            Self::ReadyCommit(_) => "ready_commit",
        }
    }
}

impl Debug for RunnerPhysicalBootstrapError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunnerPhysicalBootstrapError")
            .field("stage", &self.stage())
            .field("details", &"[REDACTED]")
            .finish()
    }
}

impl Display for RunnerPhysicalBootstrapError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::BootstrapOpen(_) => {
                formatter.write_str("cannot open the inherited runner bootstrap")
            }
            Self::HandoffReceive(_) => {
                formatter.write_str("cannot receive the physical runner handoff")
            }
            Self::ExpectedSupervisorMissing => {
                formatter.write_str("runner handoff has no expected supervisor authority")
            }
            Self::CreatorProcessMismatch { .. } => formatter
                .write_str("physical bootstrap creator does not match the expected supervisor"),
            Self::ClockBeforeUnixEpoch(_) | Self::ClockOverflow => {
                formatter.write_str("cannot sample the runner bootstrap observation time")
            }
            Self::Materialization(_) => {
                formatter.write_str("cannot materialize the runner endpoints")
            }
            Self::ReadyCommit(_) => {
                formatter.write_str("cannot commit the physical runner Ready frame")
            }
        }
    }
}

impl Error for RunnerPhysicalBootstrapError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::BootstrapOpen(source) => Some(source),
            Self::HandoffReceive(source) | Self::ReadyCommit(source) => Some(source),
            Self::ClockBeforeUnixEpoch(source) => Some(source),
            Self::Materialization(source) => Some(source),
            Self::ExpectedSupervisorMissing
            | Self::CreatorProcessMismatch { .. }
            | Self::ClockOverflow => None,
        }
    }
}
